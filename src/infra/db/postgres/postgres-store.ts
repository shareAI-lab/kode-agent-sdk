import { Pool, PoolClient } from 'pg';
import {
  ExtendedStore,
  SessionFilters,
  MessageFilters,
  ToolCallFilters,
  SessionInfo,
  AgentStats,
  JSONStore,
  PostgresConfig,
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

/**
 * PostgresStore 实现
 *
 * 混合存储策略：
 * - 数据库：AgentInfo, Messages, ToolCallRecords, Snapshots（支持查询）
 * - 文件系统：Events, Todos, History, MediaCache（高频写入）
 *
 * PostgreSQL 特性：
 * - JSONB 类型 + GIN 索引
 * - 连接池管理
 * - 事务支持
 */
export class PostgresStore implements ExtendedStore {
  private pool: Pool;
  private fileStore: JSONStore;
  private initPromise: Promise<void>;

  // 指标追踪
  private metrics = {
    saves: 0,
    loads: 0,
    queries: 0,
    deletes: 0,
    latencies: [] as number[]
  };

  constructor(config: PostgresConfig, fileStoreBaseDir: string) {
    // 合并默认配置
    const poolConfig = {
      ...config,
      port: config.port ?? 5432,
      max: config.max ?? 10,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
    };

    this.pool = new Pool(poolConfig);

    // 监听连接池错误，防止未处理的异常
    this.pool.on('error', (err) => {
      console.error('[PostgresStore] Unexpected pool error:', err.message);
    });

    this.fileStore = new JSONStore(fileStoreBaseDir);
    this.initPromise = this.initialize();
  }

  // ========== 数据库初始化 ==========

  /**
   * 确保数据库已初始化
   * 在所有公开的数据库操作方法开头调用
   */
  private async ensureInitialized(): Promise<void> {
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    await this.createTables();
    await this.createIndexes();
  }

  private async createTables(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // 表 1: agents - Agent 元信息
      await client.query(`
        CREATE TABLE IF NOT EXISTS agents (
          agent_id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL,
          created_at TIMESTAMP NOT NULL,
          config_version TEXT NOT NULL,
          lineage JSONB NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          last_sfp_index INTEGER NOT NULL DEFAULT -1,
          last_bookmark JSONB,
          breakpoint TEXT,
          metadata JSONB NOT NULL
        );
      `);

      // 表 2: messages - 对话消息
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
          content JSONB NOT NULL,
          seq INTEGER NOT NULL,
          metadata JSONB,
          created_at BIGINT NOT NULL,
          FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
        );
      `);

      // 表 3: tool_calls - 工具调用记录
      await client.query(`
        CREATE TABLE IF NOT EXISTS tool_calls (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          name TEXT NOT NULL,
          input JSONB NOT NULL,
          state TEXT NOT NULL,
          approval JSONB NOT NULL,
          result JSONB,
          error TEXT,
          is_error BOOLEAN DEFAULT FALSE,
          started_at BIGINT,
          completed_at BIGINT,
          duration_ms INTEGER,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          audit_trail JSONB NOT NULL,
          FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
        );
      `);

      // 表 4: snapshots - 快照
      await client.query(`
        CREATE TABLE IF NOT EXISTS snapshots (
          agent_id TEXT NOT NULL,
          snapshot_id TEXT NOT NULL,
          messages JSONB NOT NULL,
          last_sfp_index INTEGER NOT NULL,
          last_bookmark JSONB NOT NULL,
          created_at TIMESTAMP NOT NULL,
          metadata JSONB,
          PRIMARY KEY (agent_id, snapshot_id),
          FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE
        );
      `);
    } finally {
      client.release();
    }
  }

  private async createIndexes(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // agents 索引
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_agents_template_id ON agents(template_id);
        CREATE INDEX IF NOT EXISTS idx_agents_created_at ON agents(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agents_lineage_gin ON agents USING GIN(lineage);
      `);

      // messages 索引
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id);
        CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
        CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_agent_seq ON messages(agent_id, seq);
        CREATE INDEX IF NOT EXISTS idx_messages_content_gin ON messages USING GIN(content);
      `);

      // tool_calls 索引
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_tool_calls_agent_id ON tool_calls(agent_id);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(name);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_state ON tool_calls(state);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_input_gin ON tool_calls USING GIN(input);
      `);

      // snapshots 索引
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_snapshots_agent_id ON snapshots(agent_id);
        CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON snapshots(created_at DESC);
      `);
    } finally {
      client.release();
    }
  }

  // ========== 运行时状态管理（数据库） ==========

  async saveMessages(agentId: string, messages: Message[]): Promise<void> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. 删除旧消息
      await client.query('DELETE FROM messages WHERE agent_id = $1', [agentId]);

      // 2. 批量插入新消息
      for (let index = 0; index < messages.length; index++) {
        const msg = messages[index];
        const id = this.generateMessageId();

        await client.query(
          `INSERT INTO messages (
            id, agent_id, role, content, seq, metadata, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            agentId,
            msg.role,
            JSON.stringify(msg.content),
            index,
            msg.metadata ? JSON.stringify(msg.metadata) : null,
            Date.now()
          ]
        );
      }

      // 3. 更新 agents 表的 message_count
      await client.query(
        'UPDATE agents SET message_count = $1 WHERE agent_id = $2',
        [messages.length, agentId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async loadMessages(agentId: string): Promise<Message[]> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT role, content, metadata
         FROM messages
         WHERE agent_id = $1
         ORDER BY seq ASC`,
        [agentId]
      );

      return result.rows.map(row => ({
        role: row.role as 'user' | 'assistant' | 'system',
        content: row.content,
        metadata: row.metadata || undefined
      }));
    } finally {
      client.release();
    }
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async saveToolCallRecords(agentId: string, records: ToolCallRecord[]): Promise<void> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. 删除旧记录
      await client.query('DELETE FROM tool_calls WHERE agent_id = $1', [agentId]);

      // 2. 批量插入新记录
      for (const record of records) {
        await client.query(
          `INSERT INTO tool_calls (
            id, agent_id, name, input, state, approval,
            result, error, is_error,
            started_at, completed_at, duration_ms,
            created_at, updated_at, audit_trail
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            record.id,
            agentId,
            record.name,
            JSON.stringify(record.input),
            record.state,
            JSON.stringify(record.approval),
            record.result ? JSON.stringify(record.result) : null,
            record.error || null,
            record.isError,
            record.startedAt || null,
            record.completedAt || null,
            record.durationMs || null,
            record.createdAt,
            record.updatedAt,
            JSON.stringify(record.auditTrail)
          ]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async loadToolCallRecords(agentId: string): Promise<ToolCallRecord[]> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, name, input, state, approval,
                result, error, is_error,
                started_at, completed_at, duration_ms,
                created_at, updated_at, audit_trail
         FROM tool_calls
         WHERE agent_id = $1
         ORDER BY created_at ASC`,
        [agentId]
      );

      return result.rows.map(row => ({
        id: row.id,
        name: row.name,
        input: row.input,
        state: row.state,
        approval: row.approval,
        result: row.result || undefined,
        error: row.error || undefined,
        isError: row.is_error,
        startedAt: row.started_at || undefined,
        completedAt: row.completed_at || undefined,
        durationMs: row.duration_ms || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        auditTrail: row.audit_trail
      }));
    } finally {
      client.release();
    }
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
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO snapshots (
          agent_id, snapshot_id, messages, last_sfp_index,
          last_bookmark, created_at, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (agent_id, snapshot_id)
        DO UPDATE SET
          messages = EXCLUDED.messages,
          last_sfp_index = EXCLUDED.last_sfp_index,
          last_bookmark = EXCLUDED.last_bookmark,
          created_at = EXCLUDED.created_at,
          metadata = EXCLUDED.metadata`,
        [
          agentId,
          snapshot.id,
          JSON.stringify(snapshot.messages),
          snapshot.lastSfpIndex,
          JSON.stringify(snapshot.lastBookmark),
          snapshot.createdAt,
          snapshot.metadata ? JSON.stringify(snapshot.metadata) : null
        ]
      );
    } finally {
      client.release();
    }
  }

  async loadSnapshot(agentId: string, snapshotId: string): Promise<Snapshot | undefined> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT snapshot_id, messages, last_sfp_index,
                last_bookmark, created_at, metadata
         FROM snapshots
         WHERE agent_id = $1 AND snapshot_id = $2`,
        [agentId, snapshotId]
      );

      if (result.rows.length === 0) {
        return undefined;
      }

      const row = result.rows[0];
      return {
        id: row.snapshot_id,
        messages: row.messages,
        lastSfpIndex: row.last_sfp_index,
        lastBookmark: row.last_bookmark,
        createdAt: row.created_at,
        metadata: row.metadata || undefined
      };
    } finally {
      client.release();
    }
  }

  async listSnapshots(agentId: string): Promise<Snapshot[]> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT snapshot_id, messages, last_sfp_index,
                last_bookmark, created_at, metadata
         FROM snapshots
         WHERE agent_id = $1
         ORDER BY created_at DESC`,
        [agentId]
      );

      return result.rows.map(row => ({
        id: row.snapshot_id,
        messages: row.messages,
        lastSfpIndex: row.last_sfp_index,
        lastBookmark: row.last_bookmark,
        createdAt: row.created_at,
        metadata: row.metadata || undefined
      }));
    } finally {
      client.release();
    }
  }

  // ========== 元数据管理（数据库） ==========

  async saveInfo(agentId: string, info: AgentInfo): Promise<void> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO agents (
          agent_id, template_id, created_at, config_version,
          lineage, message_count, last_sfp_index, last_bookmark,
          breakpoint, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (agent_id)
        DO UPDATE SET
          template_id = EXCLUDED.template_id,
          created_at = EXCLUDED.created_at,
          config_version = EXCLUDED.config_version,
          lineage = EXCLUDED.lineage,
          message_count = EXCLUDED.message_count,
          last_sfp_index = EXCLUDED.last_sfp_index,
          last_bookmark = EXCLUDED.last_bookmark,
          breakpoint = EXCLUDED.breakpoint,
          metadata = EXCLUDED.metadata`,
        [
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
        ]
      );
    } finally {
      client.release();
    }
  }

  async loadInfo(agentId: string): Promise<AgentInfo | undefined> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT agent_id, template_id, created_at, config_version,
                lineage, message_count, last_sfp_index, last_bookmark,
                breakpoint, metadata
         FROM agents
         WHERE agent_id = $1`,
        [agentId]
      );

      if (result.rows.length === 0) {
        return undefined;
      }

      const row = result.rows[0];
      const info: AgentInfo = {
        agentId: row.agent_id,
        templateId: row.template_id,
        createdAt: row.created_at,
        configVersion: row.config_version,
        lineage: row.lineage,
        messageCount: row.message_count,
        lastSfpIndex: row.last_sfp_index,
        lastBookmark: row.last_bookmark || undefined,
        metadata: row.metadata
      };

      // Restore breakpoint to AgentInfo if present
      if (row.breakpoint) {
        info.breakpoint = row.breakpoint as any;
      }

      return info;
    } finally {
      client.release();
    }
  }

  // ========== 生命周期管理 ==========

  async exists(agentId: string): Promise<boolean> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT 1 FROM agents WHERE agent_id = $1',
        [agentId]
      );
      return result.rows.length > 0;
    } finally {
      client.release();
    }
  }

  async delete(agentId: string): Promise<void> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      // 删除数据库记录（级联删除）
      await client.query('DELETE FROM agents WHERE agent_id = $1', [agentId]);
      // 删除文件系统数据
      await this.fileStore.delete(agentId);
    } finally {
      client.release();
    }
  }

  async list(prefix?: string): Promise<string[]> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      let query = 'SELECT agent_id FROM agents ORDER BY created_at DESC';
      let params: any[] = [];

      if (prefix) {
        query = 'SELECT agent_id FROM agents WHERE agent_id LIKE $1 ORDER BY created_at DESC';
        params = [`${prefix}%`];
      }

      const result = await client.query(query, params);
      return result.rows.map(row => row.agent_id);
    } finally {
      client.release();
    }
  }

  // ========== QueryableStore 接口实现 ==========

  async querySessions(filters: SessionFilters): Promise<SessionInfo[]> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      let sql = `
        SELECT agent_id, template_id, created_at, message_count,
               last_sfp_index, breakpoint
        FROM agents
        WHERE 1=1
      `;
      const params: any[] = [];
      let paramIndex = 1;

      if (filters.agentId) {
        sql += ` AND agent_id = $${paramIndex++}`;
        params.push(filters.agentId);
      }

      if (filters.templateId) {
        sql += ` AND template_id = $${paramIndex++}`;
        params.push(filters.templateId);
      }

      if (filters.startDate) {
        sql += ` AND created_at >= $${paramIndex++}`;
        params.push(new Date(filters.startDate).toISOString());
      }

      if (filters.endDate) {
        sql += ` AND created_at <= $${paramIndex++}`;
        params.push(new Date(filters.endDate).toISOString());
      }

      // Sorting
      const sortBy = filters.sortBy || 'created_at';
      const sortOrder = filters.sortOrder || 'desc';
      sql += ` ORDER BY ${sortBy} ${sortOrder.toUpperCase()}`;

      // Pagination
      if (filters.limit) {
        sql += ` LIMIT $${paramIndex++}`;
        params.push(filters.limit);

        if (filters.offset) {
          sql += ` OFFSET $${paramIndex++}`;
          params.push(filters.offset);
        }
      }

      const result = await client.query(sql, params);

      return result.rows.map(row => ({
        agentId: row.agent_id,
        templateId: row.template_id,
        createdAt: row.created_at,
        messageCount: row.message_count,
        lastSfpIndex: row.last_sfp_index,
        breakpoint: row.breakpoint as any
      }));
    } finally {
      client.release();
    }
  }

  async queryMessages(filters: MessageFilters): Promise<Message[]> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      let sql = 'SELECT role, content, metadata FROM messages WHERE 1=1';
      const params: any[] = [];
      let paramIndex = 1;

      if (filters.agentId) {
        sql += ` AND agent_id = $${paramIndex++}`;
        params.push(filters.agentId);
      }

      if (filters.role) {
        sql += ` AND role = $${paramIndex++}`;
        params.push(filters.role);
      }

      if (filters.startDate) {
        sql += ` AND created_at >= $${paramIndex++}`;
        params.push(filters.startDate);
      }

      if (filters.endDate) {
        sql += ` AND created_at <= $${paramIndex++}`;
        params.push(filters.endDate);
      }

      sql += ' ORDER BY created_at DESC';

      if (filters.limit) {
        sql += ` LIMIT $${paramIndex++}`;
        params.push(filters.limit);

        if (filters.offset) {
          sql += ` OFFSET $${paramIndex++}`;
          params.push(filters.offset);
        }
      }

      const result = await client.query(sql, params);

      return result.rows.map(row => ({
        role: row.role as 'user' | 'assistant' | 'system',
        content: row.content,
        metadata: row.metadata || undefined
      }));
    } finally {
      client.release();
    }
  }

  async queryToolCalls(filters: ToolCallFilters): Promise<ToolCallRecord[]> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      let sql = `
        SELECT id, name, input, state, approval,
               result, error, is_error,
               started_at, completed_at, duration_ms,
               created_at, updated_at, audit_trail
        FROM tool_calls
        WHERE 1=1
      `;
      const params: any[] = [];
      let paramIndex = 1;

      if (filters.agentId) {
        sql += ` AND agent_id = $${paramIndex++}`;
        params.push(filters.agentId);
      }

      if (filters.toolName) {
        sql += ` AND name = $${paramIndex++}`;
        params.push(filters.toolName);
      }

      if (filters.state) {
        sql += ` AND state = $${paramIndex++}`;
        params.push(filters.state);
      }

      if (filters.startDate) {
        sql += ` AND created_at >= $${paramIndex++}`;
        params.push(filters.startDate);
      }

      if (filters.endDate) {
        sql += ` AND created_at <= $${paramIndex++}`;
        params.push(filters.endDate);
      }

      sql += ' ORDER BY created_at DESC';

      if (filters.limit) {
        sql += ` LIMIT $${paramIndex++}`;
        params.push(filters.limit);

        if (filters.offset) {
          sql += ` OFFSET $${paramIndex++}`;
          params.push(filters.offset);
        }
      }

      const result = await client.query(sql, params);

      return result.rows.map(row => ({
        id: row.id,
        name: row.name,
        input: row.input,
        state: row.state,
        approval: row.approval,
        result: row.result || undefined,
        error: row.error || undefined,
        isError: row.is_error,
        startedAt: row.started_at || undefined,
        completedAt: row.completed_at || undefined,
        durationMs: row.duration_ms || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        auditTrail: row.audit_trail
      }));
    } finally {
      client.release();
    }
  }

  async aggregateStats(agentId: string): Promise<AgentStats> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      // Total messages
      const messageStats = await client.query(
        'SELECT COUNT(*) as total FROM messages WHERE agent_id = $1',
        [agentId]
      );

      // Total tool calls
      const toolCallStats = await client.query(
        'SELECT COUNT(*) as total FROM tool_calls WHERE agent_id = $1',
        [agentId]
      );

      // Total snapshots
      const snapshotStats = await client.query(
        'SELECT COUNT(*) as total FROM snapshots WHERE agent_id = $1',
        [agentId]
      );

      // Tool calls by name
      const toolCallsByName = await client.query(
        `SELECT name, COUNT(*) as count
         FROM tool_calls
         WHERE agent_id = $1
         GROUP BY name`,
        [agentId]
      );

      // Tool calls by state
      const toolCallsByState = await client.query(
        `SELECT state, COUNT(*) as count
         FROM tool_calls
         WHERE agent_id = $1
         GROUP BY state`,
        [agentId]
      );

      return {
        totalMessages: parseInt(messageStats.rows[0].total),
        totalToolCalls: parseInt(toolCallStats.rows[0].total),
        totalSnapshots: parseInt(snapshotStats.rows[0].total),
        avgMessagesPerSession: parseInt(messageStats.rows[0].total),
        toolCallsByName: toolCallsByName.rows.reduce((acc, row) => {
          acc[row.name] = parseInt(row.count);
          return acc;
        }, {} as Record<string, number>),
        toolCallsByState: toolCallsByState.rows.reduce((acc, row) => {
          acc[row.state] = parseInt(row.count);
          return acc;
        }, {} as Record<string, number>)
      };
    } finally {
      client.release();
    }
  }

  // ========== 连接管理 ==========

  /**
   * 关闭连接池
   */
  async close(): Promise<void> {
    await this.ensureInitialized();
    await this.pool.end();
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
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
        dbConnected = true;
        dbLatencyMs = Date.now() - start;
      } finally {
        client.release();
      }
    } catch (error) {
      dbConnected = false;
    }

    // 检查文件系统
    try {
      const fs = await import('fs');
      const path = await import('path');
      const baseDir = (this.fileStore as any).baseDir;
      // 确保目录存在
      if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
      }
      const testFile = path.join(baseDir, '.health-check');
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
   * 检查数据库和文件系统之间的数据一致性
   */
  async checkConsistency(agentId: string): Promise<ConsistencyCheckResult> {
    await this.ensureInitialized();
    const issues: string[] = [];
    const checkedAt = Date.now();

    // 检查 Agent 是否存在于数据库
    const dbExists = await this.exists(agentId);
    if (!dbExists) {
      issues.push(`Agent ${agentId} 不存在于数据库中`);
      return { consistent: false, issues, checkedAt };
    }

    // 检查文件系统中的数据
    const fs = await import('fs').then(m => m.promises);
    const path = await import('path');
    const agentDir = path.join((this.fileStore as any).baseDir, agentId);

    try {
      await fs.access(agentDir);
    } catch {
      // 文件系统目录不存在不一定是问题（可能还没有事件/todos等）
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
    await this.ensureInitialized();
    const client = await this.pool.connect();

    try {
      // 获取存储统计
      const agentCount = await client.query('SELECT COUNT(*) as count FROM agents');
      const messageCount = await client.query('SELECT COUNT(*) as count FROM messages');
      const toolCallCount = await client.query('SELECT COUNT(*) as count FROM tool_calls');

      // 尝试获取数据库大小（PostgreSQL 特有）
      let dbSizeBytes: number | undefined;
      try {
        const sizeResult = await client.query(
          "SELECT pg_database_size(current_database()) as size"
        );
        dbSizeBytes = parseInt(sizeResult.rows[0].size);
      } catch {
        // 忽略，某些环境可能没有权限
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
          totalAgents: parseInt(agentCount.rows[0].count),
          totalMessages: parseInt(messageCount.rows[0].count),
          totalToolCalls: parseInt(toolCallCount.rows[0].count),
          dbSizeBytes
        },
        collectedAt: Date.now()
      };
    } finally {
      client.release();
    }
  }

  /**
   * 获取分布式锁
   * 使用 PostgreSQL Advisory Lock
   */
  async acquireAgentLock(agentId: string, timeoutMs: number = 30000): Promise<LockReleaseFn> {
    await this.ensureInitialized();

    // 将 agentId 转换为数字用于 advisory lock
    const lockKey = this.hashStringToInt(agentId);

    const client = await this.pool.connect();

    try {
      // 尝试获取锁（带超时）
      const result = await client.query(
        'SELECT pg_try_advisory_lock($1) as acquired',
        [lockKey]
      );

      if (!result.rows[0].acquired) {
        client.release();
        throw new Error(`无法获取 Agent ${agentId} 的锁，可能被其他进程占用`);
      }

      // 设置超时自动释放
      const timeoutId = setTimeout(async () => {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
          client.release();
        } catch {
          // 忽略释放错误
        }
      }, timeoutMs);

      // 返回释放函数
      return async () => {
        clearTimeout(timeoutId);
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        } finally {
          client.release();
        }
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }

  /**
   * 批量 Fork Agent
   */
  async batchFork(agentId: string, count: number): Promise<string[]> {
    await this.ensureInitialized();

    // 加载源 Agent 数据
    const sourceInfo = await this.loadInfo(agentId);
    if (!sourceInfo) {
      throw new Error(`源 Agent ${agentId} 不存在`);
    }

    const sourceMessages = await this.loadMessages(agentId);
    const sourceToolCalls = await this.loadToolCallRecords(agentId);

    const client = await this.pool.connect();
    const newAgentIds: string[] = [];

    try {
      await client.query('BEGIN');

      for (let i = 0; i < count; i++) {
        // 生成新的 Agent ID
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
        await client.query(
          `INSERT INTO agents (
            agent_id, template_id, created_at, config_version,
            lineage, message_count, last_sfp_index, last_bookmark,
            breakpoint, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
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
          ]
        );

        // 复制消息
        for (let index = 0; index < sourceMessages.length; index++) {
          const msg = sourceMessages[index];
          await client.query(
            `INSERT INTO messages (
              id, agent_id, role, content, seq, metadata, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              this.generateMessageId(),
              newAgentId,
              msg.role,
              JSON.stringify(msg.content),
              index,
              msg.metadata ? JSON.stringify(msg.metadata) : null,
              Date.now()
            ]
          );
        }

        // 复制工具调用记录
        for (const record of sourceToolCalls) {
          await client.query(
            `INSERT INTO tool_calls (
              id, agent_id, name, input, state, approval,
              result, error, is_error,
              started_at, completed_at, duration_ms,
              created_at, updated_at, audit_trail
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
              `${record.id}_fork_${i}`,
              newAgentId,
              record.name,
              JSON.stringify(record.input),
              record.state,
              JSON.stringify(record.approval),
              record.result ? JSON.stringify(record.result) : null,
              record.error || null,
              record.isError,
              record.startedAt || null,
              record.completedAt || null,
              record.durationMs || null,
              record.createdAt,
              record.updatedAt,
              JSON.stringify(record.auditTrail)
            ]
          );
        }
      }

      await client.query('COMMIT');
      return newAgentIds;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 将字符串哈希为整数（用于 advisory lock）
   */
  private hashStringToInt(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
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
