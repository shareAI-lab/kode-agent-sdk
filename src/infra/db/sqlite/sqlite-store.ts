import Database from 'better-sqlite3';
import {
  ExtendedStore,
  SessionFilters,
  MessageFilters,
  ToolCallFilters,
  SessionInfo,
  AgentStats,
  JSONStore,
  StoreHealthStatus,
  ConsistencyCheckResult,
  StoreMetrics,
  LockReleaseFn
} from '../../store';
import {
  Message,
  Timeline,
  Snapshot,
  AgentInfo,
  ToolCallRecord,
  Bookmark,
  AgentChannel
} from '../../../core/types';
import { TodoSnapshot } from '../../../core/todo';
import { HistoryWindow, CompressionRecord, RecoveredFile, MediaCacheRecord } from '../../store';
import * as fs from 'fs';
import * as pathModule from 'path';

/**
 * SqliteStore 实现
 *
 * 混合存储策略：
 * - 数据库：AgentInfo, Messages, ToolCallRecords, Snapshots（支持查询）
 * - 文件系统：Events, Todos, History, MediaCache（高频写入）
 */
export class SqliteStore implements ExtendedStore {
  private db: Database.Database;
  private fileStore: JSONStore;
  private dbPath: string;

  // 指标追踪
  private metrics = {
    saves: 0,
    loads: 0,
    queries: 0,
    deletes: 0,
    latencies: [] as number[]
  };

  // 内存锁（单进程场景）
  private locks = new Map<string, { resolve: () => void; timeout: NodeJS.Timeout }>();

  constructor(dbPath: string, fileStoreBaseDir?: string) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.fileStore = new JSONStore(fileStoreBaseDir || pathModule.dirname(dbPath));
    this.initialize();
  }

  // ========== 数据库初始化 ==========

  private initialize(): void {
    this.createTables();
    this.createIndexes();
  }

  private createTables(): void {
    // 表 1: agents - Agent 元信息
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        config_version TEXT NOT NULL,
        lineage TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        last_sfp_index INTEGER NOT NULL DEFAULT -1,
        last_bookmark TEXT,
        breakpoint TEXT,
        metadata TEXT NOT NULL
      );
    `);

    // 表 2: messages - 对话消息
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        seq INTEGER NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
      );
    `);

    // 表 3: tool_calls - 工具调用记录
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        input TEXT NOT NULL,
        state TEXT NOT NULL,
        approval TEXT NOT NULL,
        result TEXT,
        error TEXT,
        is_error INTEGER DEFAULT 0,
        started_at INTEGER,
        completed_at INTEGER,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        audit_trail TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
      );
    `);

    // 表 4: snapshots - 快照
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        agent_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        messages TEXT NOT NULL,
        last_sfp_index INTEGER NOT NULL,
        last_bookmark TEXT NOT NULL,
        created_at TEXT NOT NULL,
        metadata TEXT,
        PRIMARY KEY (agent_id, snapshot_id),
        FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
      );
    `);
  }

  private createIndexes(): void {
    // agents 索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agents_template_id ON agents(template_id);
      CREATE INDEX IF NOT EXISTS idx_agents_created_at ON agents(created_at);
    `);

    // messages 索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id);
      CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_agent_seq ON messages(agent_id, seq);
    `);

    // tool_calls 索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tool_calls_agent_id ON tool_calls(agent_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(name);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_state ON tool_calls(state);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at DESC);
    `);

    // snapshots 索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_agent_id ON snapshots(agent_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON snapshots(created_at DESC);
    `);
  }

  // ========== 运行时状态管理（数据库） ==========

  async saveMessages(agentId: string, messages: Message[]): Promise<void> {
    const saveMessagesTransaction = this.db.transaction(() => {
      // 1. 删除旧消息
      this.db.prepare('DELETE FROM messages WHERE agent_id = ?').run(agentId);

      // 2. 批量插入新消息
      const insertStmt = this.db.prepare(`
        INSERT INTO messages (
          id, agent_id, role, content, seq, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      messages.forEach((msg, index) => {
        const id = this.generateMessageId();
        insertStmt.run(
          id,
          agentId,
          msg.role,
          JSON.stringify(msg.content),
          index, // seq: array index
          msg.metadata ? JSON.stringify(msg.metadata) : null,
          Date.now()
        );
      });

      // 3. 更新 agents 表的 message_count
      this.db.prepare(`
        UPDATE agents
        SET message_count = ?
        WHERE agent_id = ?
      `).run(messages.length, agentId);
    });

    saveMessagesTransaction();
  }

  async loadMessages(agentId: string): Promise<Message[]> {
    const rows = this.db.prepare(`
      SELECT role, content, metadata
      FROM messages
      WHERE agent_id = ?
      ORDER BY seq ASC
    `).all(agentId) as Array<{
      role: string;
      content: string;
      metadata: string | null;
    }>;

    return rows.map(row => ({
      role: row.role as 'user' | 'assistant' | 'system',
      content: JSON.parse(row.content),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    }));
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async saveToolCallRecords(agentId: string, records: ToolCallRecord[]): Promise<void> {
    const saveToolCallsTransaction = this.db.transaction(() => {
      // 1. 删除旧记录
      this.db.prepare('DELETE FROM tool_calls WHERE agent_id = ?').run(agentId);

      // 2. 批量插入新记录
      const insertStmt = this.db.prepare(`
        INSERT INTO tool_calls (
          id, agent_id, name, input, state, approval,
          result, error, is_error,
          started_at, completed_at, duration_ms,
          created_at, updated_at, audit_trail
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      records.forEach(record => {
        insertStmt.run(
          record.id,
          agentId,
          record.name,
          JSON.stringify(record.input),
          record.state,
          JSON.stringify(record.approval),
          record.result ? JSON.stringify(record.result) : null,
          record.error || null,
          record.isError ? 1 : 0,
          record.startedAt || null,
          record.completedAt || null,
          record.durationMs || null,
          record.createdAt,
          record.updatedAt,
          JSON.stringify(record.auditTrail)
        );
      });
    });

    saveToolCallsTransaction();
  }

  async loadToolCallRecords(agentId: string): Promise<ToolCallRecord[]> {
    const rows = this.db.prepare(`
      SELECT id, name, input, state, approval,
             result, error, is_error,
             started_at, completed_at, duration_ms,
             created_at, updated_at, audit_trail
      FROM tool_calls
      WHERE agent_id = ?
      ORDER BY created_at ASC
    `).all(agentId) as Array<{
      id: string;
      name: string;
      input: string;
      state: string;
      approval: string;
      result: string | null;
      error: string | null;
      is_error: number;
      started_at: number | null;
      completed_at: number | null;
      duration_ms: number | null;
      created_at: number;
      updated_at: number;
      audit_trail: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      input: JSON.parse(row.input),
      state: row.state as any,
      approval: JSON.parse(row.approval),
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error || undefined,
      isError: row.is_error === 1,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
      durationMs: row.duration_ms || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      auditTrail: JSON.parse(row.audit_trail)
    }));
  }

  // ========== 事件流管理（文件系统） ==========

  async saveTodos(agentId: string, snapshot: TodoSnapshot): Promise<void> {
    return this.fileStore.saveTodos(agentId, snapshot);
  }

  async loadTodos(agentId: string): Promise<TodoSnapshot | undefined> {
    return this.fileStore.loadTodos(agentId);
  }

  async appendEvent(agentId: string, timeline: Timeline): Promise<void> {
    return this.fileStore.appendEvent(agentId, timeline);
  }

  async *readEvents(agentId: string, opts?: { since?: Bookmark; channel?: AgentChannel }): AsyncIterable<Timeline> {
    yield* this.fileStore.readEvents(agentId, opts);
  }

  // ========== 历史与压缩管理（文件系统） ==========

  async saveHistoryWindow(agentId: string, window: HistoryWindow): Promise<void> {
    return this.fileStore.saveHistoryWindow(agentId, window);
  }

  async loadHistoryWindows(agentId: string): Promise<HistoryWindow[]> {
    return this.fileStore.loadHistoryWindows(agentId);
  }

  async saveCompressionRecord(agentId: string, record: CompressionRecord): Promise<void> {
    return this.fileStore.saveCompressionRecord(agentId, record);
  }

  async loadCompressionRecords(agentId: string): Promise<CompressionRecord[]> {
    return this.fileStore.loadCompressionRecords(agentId);
  }

  async saveRecoveredFile(agentId: string, file: RecoveredFile): Promise<void> {
    return this.fileStore.saveRecoveredFile(agentId, file);
  }

  async loadRecoveredFiles(agentId: string): Promise<RecoveredFile[]> {
    return this.fileStore.loadRecoveredFiles(agentId);
  }

  // ========== 多模态缓存管理（文件系统） ==========

  async saveMediaCache(agentId: string, records: MediaCacheRecord[]): Promise<void> {
    return this.fileStore.saveMediaCache(agentId, records);
  }

  async loadMediaCache(agentId: string): Promise<MediaCacheRecord[]> {
    return this.fileStore.loadMediaCache(agentId);
  }

  // ========== 快照管理（数据库） ==========

  async saveSnapshot(agentId: string, snapshot: Snapshot): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO snapshots (
        agent_id, snapshot_id, messages, last_sfp_index,
        last_bookmark, created_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      agentId,
      snapshot.id,
      JSON.stringify(snapshot.messages),
      snapshot.lastSfpIndex,
      JSON.stringify(snapshot.lastBookmark),
      snapshot.createdAt,
      snapshot.metadata ? JSON.stringify(snapshot.metadata) : null
    );
  }

  async loadSnapshot(agentId: string, snapshotId: string): Promise<Snapshot | undefined> {
    const row = this.db.prepare(`
      SELECT snapshot_id, messages, last_sfp_index,
             last_bookmark, created_at, metadata
      FROM snapshots
      WHERE agent_id = ? AND snapshot_id = ?
    `).get(agentId, snapshotId) as {
      snapshot_id: string;
      messages: string;
      last_sfp_index: number;
      last_bookmark: string;
      created_at: string;
      metadata: string | null;
    } | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.snapshot_id,
      messages: JSON.parse(row.messages),
      lastSfpIndex: row.last_sfp_index,
      lastBookmark: JSON.parse(row.last_bookmark),
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    };
  }

  async listSnapshots(agentId: string): Promise<Snapshot[]> {
    const rows = this.db.prepare(`
      SELECT snapshot_id, messages, last_sfp_index,
             last_bookmark, created_at, metadata
      FROM snapshots
      WHERE agent_id = ?
      ORDER BY created_at DESC
    `).all(agentId) as Array<{
      snapshot_id: string;
      messages: string;
      last_sfp_index: number;
      last_bookmark: string;
      created_at: string;
      metadata: string | null;
    }>;

    return rows.map(row => ({
      id: row.snapshot_id,
      messages: JSON.parse(row.messages),
      lastSfpIndex: row.last_sfp_index,
      lastBookmark: JSON.parse(row.last_bookmark),
      createdAt: row.created_at,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    }));
  }

  // ========== 元数据管理（数据库） ==========

  async saveInfo(agentId: string, info: AgentInfo): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO agents (
        agent_id, template_id, created_at, config_version,
        lineage, message_count, last_sfp_index, last_bookmark,
        breakpoint, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      info.agentId,
      info.templateId,
      info.createdAt,
      info.configVersion,
      JSON.stringify(info.lineage),
      info.messageCount,
      info.lastSfpIndex,
      info.lastBookmark ? JSON.stringify(info.lastBookmark) : null,
      info.breakpoint || null,
      JSON.stringify(info.metadata)
    );
  }

  async loadInfo(agentId: string): Promise<AgentInfo | undefined> {
    const row = this.db.prepare(`
      SELECT agent_id, template_id, created_at, config_version,
             lineage, message_count, last_sfp_index, last_bookmark,
             breakpoint, metadata
      FROM agents
      WHERE agent_id = ?
    `).get(agentId) as {
      agent_id: string;
      template_id: string;
      created_at: string;
      config_version: string;
      lineage: string;
      message_count: number;
      last_sfp_index: number;
      last_bookmark: string | null;
      breakpoint: string | null;
      metadata: string;
    } | undefined;

    if (!row) {
      return undefined;
    }

    const info: AgentInfo = {
      agentId: row.agent_id,
      templateId: row.template_id,
      createdAt: row.created_at,
      configVersion: row.config_version,
      lineage: JSON.parse(row.lineage),
      messageCount: row.message_count,
      lastSfpIndex: row.last_sfp_index,
      lastBookmark: row.last_bookmark ? JSON.parse(row.last_bookmark) : undefined,
      metadata: JSON.parse(row.metadata)
    };

    // Restore breakpoint to AgentInfo if present
    if (row.breakpoint) {
      info.breakpoint = row.breakpoint as any;
    }

    return info;
  }

  // ========== 生命周期管理 ==========

  async exists(agentId: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 FROM agents WHERE agent_id = ?').get(agentId);
    return !!row;
  }

  async delete(agentId: string): Promise<void> {
    // 删除数据库记录（级联删除）
    this.db.prepare('DELETE FROM agents WHERE agent_id = ?').run(agentId);
    // 删除文件系统数据
    await this.fileStore.delete(agentId);
  }

  async list(prefix?: string): Promise<string[]> {
    const sql = prefix
      ? 'SELECT agent_id FROM agents WHERE agent_id LIKE ? ORDER BY created_at DESC'
      : 'SELECT agent_id FROM agents ORDER BY created_at DESC';

    const params = prefix ? [`${prefix}%`] : [];
    const rows = this.db.prepare(sql).all(...params) as Array<{ agent_id: string }>;

    return rows.map(row => row.agent_id);
  }

  // ========== QueryableStore 接口实现 ==========

  async querySessions(filters: SessionFilters): Promise<SessionInfo[]> {
    let sql = `
      SELECT agent_id, template_id, created_at, message_count,
             last_sfp_index, breakpoint
      FROM agents
      WHERE 1=1
    `;
    const params: any[] = [];

    if (filters.agentId) {
      sql += ' AND agent_id = ?';
      params.push(filters.agentId);
    }

    if (filters.templateId) {
      sql += ' AND template_id = ?';
      params.push(filters.templateId);
    }

    if (filters.startDate) {
      sql += ' AND created_at >= ?';
      params.push(new Date(filters.startDate).toISOString());
    }

    if (filters.endDate) {
      sql += ' AND created_at <= ?';
      params.push(new Date(filters.endDate).toISOString());
    }

    // Sorting
    const sortBy = filters.sortBy || 'created_at';
    const sortOrder = filters.sortOrder || 'desc';
    sql += ` ORDER BY ${sortBy} ${sortOrder.toUpperCase()}`;

    // Pagination
    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);

      if (filters.offset) {
        sql += ' OFFSET ?';
        params.push(filters.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      agent_id: string;
      template_id: string;
      created_at: string;
      message_count: number;
      last_sfp_index: number;
      breakpoint: string | null;
    }>;

    return rows.map(row => ({
      agentId: row.agent_id,
      templateId: row.template_id,
      createdAt: row.created_at,
      messageCount: row.message_count,
      lastSfpIndex: row.last_sfp_index,
      breakpoint: row.breakpoint as any
    }));
  }

  async queryMessages(filters: MessageFilters): Promise<Message[]> {
    let sql = 'SELECT role, content, metadata FROM messages WHERE 1=1';
    const params: any[] = [];

    if (filters.agentId) {
      sql += ' AND agent_id = ?';
      params.push(filters.agentId);
    }

    if (filters.role) {
      sql += ' AND role = ?';
      params.push(filters.role);
    }

    if (filters.startDate) {
      sql += ' AND created_at >= ?';
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      sql += ' AND created_at <= ?';
      params.push(filters.endDate);
    }

    sql += ' ORDER BY created_at DESC';

    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);

      if (filters.offset) {
        sql += ' OFFSET ?';
        params.push(filters.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      role: string;
      content: string;
      metadata: string | null;
    }>;

    return rows.map(row => ({
      role: row.role as 'user' | 'assistant' | 'system',
      content: JSON.parse(row.content),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    }));
  }

  async queryToolCalls(filters: ToolCallFilters): Promise<ToolCallRecord[]> {
    let sql = `
      SELECT id, name, input, state, approval,
             result, error, is_error,
             started_at, completed_at, duration_ms,
             created_at, updated_at, audit_trail
      FROM tool_calls
      WHERE 1=1
    `;
    const params: any[] = [];

    if (filters.agentId) {
      sql += ' AND agent_id = ?';
      params.push(filters.agentId);
    }

    if (filters.toolName) {
      sql += ' AND name = ?';
      params.push(filters.toolName);
    }

    if (filters.state) {
      sql += ' AND state = ?';
      params.push(filters.state);
    }

    if (filters.startDate) {
      sql += ' AND created_at >= ?';
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      sql += ' AND created_at <= ?';
      params.push(filters.endDate);
    }

    sql += ' ORDER BY created_at DESC';

    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);

      if (filters.offset) {
        sql += ' OFFSET ?';
        params.push(filters.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      name: string;
      input: string;
      state: string;
      approval: string;
      result: string | null;
      error: string | null;
      is_error: number;
      started_at: number | null;
      completed_at: number | null;
      duration_ms: number | null;
      created_at: number;
      updated_at: number;
      audit_trail: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      input: JSON.parse(row.input),
      state: row.state as any,
      approval: JSON.parse(row.approval),
      result: row.result ? JSON.parse(row.result) : undefined,
      error: row.error || undefined,
      isError: row.is_error === 1,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
      durationMs: row.duration_ms || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      auditTrail: JSON.parse(row.audit_trail)
    }));
  }

  async aggregateStats(agentId: string): Promise<AgentStats> {
    // Total messages
    const messageStats = this.db.prepare(`
      SELECT COUNT(*) as total FROM messages WHERE agent_id = ?
    `).get(agentId) as { total: number };

    // Total tool calls
    const toolCallStats = this.db.prepare(`
      SELECT COUNT(*) as total FROM tool_calls WHERE agent_id = ?
    `).get(agentId) as { total: number };

    // Total snapshots
    const snapshotStats = this.db.prepare(`
      SELECT COUNT(*) as total FROM snapshots WHERE agent_id = ?
    `).get(agentId) as { total: number };

    // Tool calls by name
    const toolCallsByName = this.db.prepare(`
      SELECT name, COUNT(*) as count
      FROM tool_calls
      WHERE agent_id = ?
      GROUP BY name
    `).all(agentId) as Array<{ name: string; count: number }>;

    // Tool calls by state
    const toolCallsByState = this.db.prepare(`
      SELECT state, COUNT(*) as count
      FROM tool_calls
      WHERE agent_id = ?
      GROUP BY state
    `).all(agentId) as Array<{ state: string; count: number }>;

    return {
      totalMessages: messageStats.total,
      totalToolCalls: toolCallStats.total,
      totalSnapshots: snapshotStats.total,
      avgMessagesPerSession: messageStats.total, // Single agent, so avg = total
      toolCallsByName: toolCallsByName.reduce((acc, row) => {
        acc[row.name] = row.count;
        return acc;
      }, {} as Record<string, number>),
      toolCallsByState: toolCallsByState.reduce((acc, row) => {
        acc[row.state] = row.count;
        return acc;
      }, {} as Record<string, number>)
    };
  }

  // ========== ExtendedStore 高级功能 ==========

  /**
   * 健康检查
   */
  async healthCheck(): Promise<StoreHealthStatus> {
    const checkedAt = Date.now();
    let dbConnected = false;
    let dbLatencyMs: number | undefined;
    let fsWritable = false;

    // 检查数据库连接
    try {
      const start = Date.now();
      this.db.prepare('SELECT 1').get();
      dbConnected = true;
      dbLatencyMs = Date.now() - start;
    } catch (error) {
      dbConnected = false;
    }

    // 检查文件系统
    try {
      const baseDir = (this.fileStore as any).baseDir;
      // 确保目录存在
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }
      const testFile = pathModule.join(baseDir, '.health-check');
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
      fsWritable = true;
    } catch (error) {
      fsWritable = false;
    }

    return {
      healthy: dbConnected && fsWritable,
      database: {
        connected: dbConnected,
        latencyMs: dbLatencyMs
      },
      fileSystem: {
        writable: fsWritable
      },
      checkedAt
    };
  }

  /**
   * 一致性检查
   */
  async checkConsistency(agentId: string): Promise<ConsistencyCheckResult> {
    const issues: string[] = [];
    const checkedAt = Date.now();

    // 检查 Agent 是否存在于数据库
    const dbExists = await this.exists(agentId);
    if (!dbExists) {
      issues.push(`Agent ${agentId} 不存在于数据库中`);
      return { consistent: false, issues, checkedAt };
    }

    // 检查消息数量一致性
    const info = await this.loadInfo(agentId);
    const messages = await this.loadMessages(agentId);
    if (info && info.messageCount !== messages.length) {
      issues.push(`消息数量不一致: info.messageCount=${info.messageCount}, 实际消息数=${messages.length}`);
    }

    // 检查工具调用记录
    const toolCalls = await this.loadToolCallRecords(agentId);
    for (const call of toolCalls) {
      if (!call.id || !call.name) {
        issues.push(`工具调用记录缺少必要字段: ${JSON.stringify(call)}`);
      }
    }

    return {
      consistent: issues.length === 0,
      issues,
      checkedAt
    };
  }

  /**
   * 获取指标统计
   */
  async getMetrics(): Promise<StoreMetrics> {
    // 获取存储统计
    const agentCount = this.db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
    const messageCount = this.db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
    const toolCallCount = this.db.prepare('SELECT COUNT(*) as count FROM tool_calls').get() as { count: number };

    // 获取数据库文件大小
    let dbSizeBytes: number | undefined;
    try {
      const stats = fs.statSync(this.dbPath);
      dbSizeBytes = stats.size;
    } catch {
      // 忽略
    }

    // 计算性能指标
    const latencies = this.metrics.latencies;
    const avgLatencyMs = latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;
    const maxLatencyMs = latencies.length > 0 ? Math.max(...latencies) : 0;
    const minLatencyMs = latencies.length > 0 ? Math.min(...latencies) : 0;

    return {
      operations: {
        saves: this.metrics.saves,
        loads: this.metrics.loads,
        queries: this.metrics.queries,
        deletes: this.metrics.deletes
      },
      performance: {
        avgLatencyMs,
        maxLatencyMs,
        minLatencyMs
      },
      storage: {
        totalAgents: agentCount.count,
        totalMessages: messageCount.count,
        totalToolCalls: toolCallCount.count,
        dbSizeBytes
      },
      collectedAt: Date.now()
    };
  }

  /**
   * 获取分布式锁
   * SQLite 使用内存锁（仅单进程有效）
   * 注意：对于多进程场景，建议使用 PostgreSQL
   */
  async acquireAgentLock(agentId: string, timeoutMs: number = 30000): Promise<LockReleaseFn> {
    // 检查是否已有锁
    if (this.locks.has(agentId)) {
      throw new Error(`无法获取 Agent ${agentId} 的锁，已被当前进程占用`);
    }

    // 创建锁
    let resolveRelease: () => void;
    const lockPromise = new Promise<void>(resolve => {
      resolveRelease = resolve;
    });

    const timeoutId = setTimeout(() => {
      this.locks.delete(agentId);
      resolveRelease!();
    }, timeoutMs);

    this.locks.set(agentId, { resolve: resolveRelease!, timeout: timeoutId });

    // 返回释放函数
    return async () => {
      const lock = this.locks.get(agentId);
      if (lock) {
        clearTimeout(lock.timeout);
        this.locks.delete(agentId);
        lock.resolve();
      }
    };
  }

  /**
   * 批量 Fork Agent
   */
  async batchFork(agentId: string, count: number): Promise<string[]> {
    // 加载源 Agent 数据
    const sourceInfo = await this.loadInfo(agentId);
    if (!sourceInfo) {
      throw new Error(`源 Agent ${agentId} 不存在`);
    }

    const sourceMessages = await this.loadMessages(agentId);
    const sourceToolCalls = await this.loadToolCallRecords(agentId);

    const newAgentIds: string[] = [];

    // 使用事务批量创建
    const transaction = this.db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const newAgentId = this.generateAgentId();
        newAgentIds.push(newAgentId);

        // 创建新 Agent Info
        const newInfo = {
          ...sourceInfo,
          agentId: newAgentId,
          createdAt: new Date().toISOString(),
          lineage: [...sourceInfo.lineage, agentId]
        };

        // 插入 Agent Info
        this.db.prepare(`
          INSERT INTO agents (
            agent_id, template_id, created_at, config_version,
            lineage, message_count, last_sfp_index, last_bookmark,
            breakpoint, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          newInfo.agentId,
          newInfo.templateId,
          newInfo.createdAt,
          newInfo.configVersion,
          JSON.stringify(newInfo.lineage),
          newInfo.messageCount,
          newInfo.lastSfpIndex,
          newInfo.lastBookmark ? JSON.stringify(newInfo.lastBookmark) : null,
          newInfo.breakpoint || null,
          JSON.stringify(newInfo.metadata)
        );

        // 复制消息
        for (let index = 0; index < sourceMessages.length; index++) {
          const msg = sourceMessages[index];
          this.db.prepare(`
            INSERT INTO messages (
              id, agent_id, role, content, seq, metadata, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            this.generateMessageId(),
            newAgentId,
            msg.role,
            JSON.stringify(msg.content),
            index,
            msg.metadata ? JSON.stringify(msg.metadata) : null,
            Date.now()
          );
        }

        // 复制工具调用记录
        for (const record of sourceToolCalls) {
          this.db.prepare(`
            INSERT INTO tool_calls (
              id, agent_id, name, input, state, approval,
              result, error, is_error,
              started_at, completed_at, duration_ms,
              created_at, updated_at, audit_trail
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            `${record.id}_fork_${i}`,
            newAgentId,
            record.name,
            JSON.stringify(record.input),
            record.state,
            JSON.stringify(record.approval),
            record.result ? JSON.stringify(record.result) : null,
            record.error || null,
            record.isError ? 1 : 0,
            record.startedAt || null,
            record.completedAt || null,
            record.durationMs || null,
            record.createdAt,
            record.updatedAt,
            JSON.stringify(record.auditTrail)
          );
        }
      }
    });

    transaction();
    return newAgentIds;
  }

  /**
   * 关闭数据库连接
   */
  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * 生成 Agent ID
   */
  private generateAgentId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 18);
    return `agt-${timestamp}${random}`;
  }
}
