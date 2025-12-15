import type { Message, ToolCallRecord } from './types';
import type { ToolDescriptor } from '../tools/registry';

/**
 * Agent 状态快照
 */
export interface AgentState {
  status: 'ready' | 'working' | 'paused' | 'completed' | 'failed';
  stepCount: number;
  lastSfpIndex: number;
  lastBookmark?: {
    seq: number;
    timestamp: number;
  };
}

/**
 * Checkpoint 数据结构
 */
export interface Checkpoint {
  id: string;
  agentId: string;
  sessionId?: string;
  timestamp: number;
  version: string;

  // Agent 状态
  state: AgentState;
  messages: Message[];
  toolRecords: ToolCallRecord[];

  // 工具恢复信息
  tools: ToolDescriptor[];

  // 配置
  config: {
    model: string;
    systemPrompt?: string;
    templateId?: string;
  };

  // 元数据
  metadata: {
    isForkPoint?: boolean;
    parentCheckpointId?: string;
    tags?: string[];
    [key: string]: any;
  };
}

/**
 * Checkpoint 元数据（列表时使用）
 */
export interface CheckpointMetadata {
  id: string;
  agentId: string;
  sessionId?: string;
  timestamp: number;
  isForkPoint?: boolean;
  tags?: string[];
}

/**
 * Checkpointer 接口
 *
 * 提供可选的持久化机制，解耦 Store 强依赖
 */
export interface Checkpointer {
  /**
   * 保存 checkpoint
   */
  save(checkpoint: Checkpoint): Promise<string>;

  /**
   * 加载 checkpoint
   */
  load(checkpointId: string): Promise<Checkpoint | null>;

  /**
   * 列出 Agent 的所有 checkpoints
   */
  list(
    agentId: string,
    options?: {
      sessionId?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<CheckpointMetadata[]>;

  /**
   * 删除 checkpoint
   */
  delete(checkpointId: string): Promise<void>;

  /**
   * Fork checkpoint（可选）
   */
  fork?(checkpointId: string, newAgentId: string): Promise<string>;
}

/**
 * 内存 Checkpointer（默认实现）
 */
export class MemoryCheckpointer implements Checkpointer {
  private checkpoints = new Map<string, Checkpoint>();

  async save(checkpoint: Checkpoint): Promise<string> {
    this.checkpoints.set(checkpoint.id, JSON.parse(JSON.stringify(checkpoint)));
    return checkpoint.id;
  }

  async load(checkpointId: string): Promise<Checkpoint | null> {
    const checkpoint = this.checkpoints.get(checkpointId);
    return checkpoint ? JSON.parse(JSON.stringify(checkpoint)) : null;
  }

  async list(
    agentId: string,
    options?: { sessionId?: string; limit?: number; offset?: number }
  ): Promise<CheckpointMetadata[]> {
    const allCheckpoints = Array.from(this.checkpoints.values())
      .filter((cp) => cp.agentId === agentId)
      .filter((cp) => !options?.sessionId || cp.sessionId === options.sessionId)
      .sort((a, b) => b.timestamp - a.timestamp);

    const start = options?.offset || 0;
    const end = options?.limit ? start + options.limit : undefined;
    const slice = allCheckpoints.slice(start, end);

    return slice.map((cp) => ({
      id: cp.id,
      agentId: cp.agentId,
      sessionId: cp.sessionId,
      timestamp: cp.timestamp,
      isForkPoint: cp.metadata.isForkPoint,
      tags: cp.metadata.tags,
    }));
  }

  async delete(checkpointId: string): Promise<void> {
    this.checkpoints.delete(checkpointId);
  }

  async fork(checkpointId: string, newAgentId: string): Promise<string> {
    const original = await this.load(checkpointId);
    if (!original) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    const forked: Checkpoint = {
      ...original,
      id: `${newAgentId}-${Date.now()}`,
      agentId: newAgentId,
      timestamp: Date.now(),
      metadata: {
        ...original.metadata,
        parentCheckpointId: checkpointId,
      },
    };

    return await this.save(forked);
  }
}
