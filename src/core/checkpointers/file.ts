import { promises as fs } from 'fs';
import * as path from 'path';
import type { Checkpointer, Checkpoint, CheckpointMetadata } from '../checkpointer';

/**
 * File-based Checkpointer
 *
 * 将 checkpoints 保存到本地文件系统
 */
export class FileCheckpointer implements Checkpointer {
  constructor(private readonly baseDir: string) {}

  async save(checkpoint: Checkpoint): Promise<string> {
    await this.ensureDir();
    const agentDir = path.join(this.baseDir, checkpoint.agentId);
    await fs.mkdir(agentDir, { recursive: true });

    const filePath = path.join(agentDir, `${checkpoint.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');

    return checkpoint.id;
  }

  async load(checkpointId: string): Promise<Checkpoint | null> {
    try {
      // 扫描所有 agent 目录查找 checkpoint
      const agentDirs = await fs.readdir(this.baseDir);

      for (const agentId of agentDirs) {
        const agentDir = path.join(this.baseDir, agentId);
        const stat = await fs.stat(agentDir);

        if (!stat.isDirectory()) continue;

        const filePath = path.join(agentDir, `${checkpointId}.json`);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          return JSON.parse(content);
        } catch {
          continue;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  async list(
    agentId: string,
    options?: { sessionId?: string; limit?: number; offset?: number }
  ): Promise<CheckpointMetadata[]> {
    const agentDir = path.join(this.baseDir, agentId);

    try {
      const files = await fs.readdir(agentDir);
      const checkpoints: CheckpointMetadata[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(agentDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        const checkpoint: Checkpoint = JSON.parse(content);

        if (options?.sessionId && checkpoint.sessionId !== options.sessionId) {
          continue;
        }

        checkpoints.push({
          id: checkpoint.id,
          agentId: checkpoint.agentId,
          sessionId: checkpoint.sessionId,
          timestamp: checkpoint.timestamp,
          isForkPoint: checkpoint.metadata.isForkPoint,
          tags: checkpoint.metadata.tags,
        });
      }

      // 按时间排序
      checkpoints.sort((a, b) => b.timestamp - a.timestamp);

      // 分页
      const start = options?.offset || 0;
      const end = options?.limit ? start + options.limit : undefined;

      return checkpoints.slice(start, end);
    } catch {
      return [];
    }
  }

  async delete(checkpointId: string): Promise<void> {
    try {
      const agentDirs = await fs.readdir(this.baseDir);

      for (const agentId of agentDirs) {
        const filePath = path.join(this.baseDir, agentId, `${checkpointId}.json`);
        try {
          await fs.unlink(filePath);
          return;
        } catch {
          continue;
        }
      }
    } catch {
      // Ignore errors
    }
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

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }
}
