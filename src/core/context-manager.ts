import { Message, Timeline } from './types';
import { Store, HistoryWindow, CompressionRecord, RecoveredFile } from '../infra/store';
import { Sandbox } from '../infra/sandbox';

export interface ContextUsage {
  totalTokens: number;
  messageCount: number;
  shouldCompress: boolean;
}

export interface CompressionResult {
  summary: Message;
  removedMessages: Message[];
  retainedMessages: Message[];
  windowId: string;
  compressionId: string;
  ratio: number;
}

export interface ContextManagerOptions {
  maxTokens?: number;
  compressToTokens?: number;
  compressionModel?: string;
  compressionPrompt?: string;
  multimodalRetention?: { keepRecent?: number };
}

export interface FilePoolState {
  getAccessedFiles(): Array<{ path: string; mtime: number }>;
}

/**
 * ContextManager v2 - 带完整历史追踪的上下文管理器
 *
 * 职责：
 * 1. 分析上下文使用情况（token 估算）
 * 2. 压缩超限上下文并保存历史窗口
 * 3. 保存压缩记录与文件快照
 * 4. 发送 Monitor 事件以供审计
 */
export class ContextManager {
  private readonly maxTokens: number;
  private readonly compressToTokens: number;
  private readonly compressionModel: string;
  private readonly compressionPrompt: string;
  private readonly keepRecentMultimodal: number;

  constructor(
    private readonly store: Store,
    private readonly agentId: string,
    opts?: ContextManagerOptions
  ) {
    this.maxTokens = opts?.maxTokens ?? 50_000;
    this.compressToTokens = opts?.compressToTokens ?? 30_000;
    this.compressionModel = opts?.compressionModel ?? 'claude-3-haiku';
    this.compressionPrompt = opts?.compressionPrompt ?? 'Summarize the conversation history concisely';
    const keepRecent = opts?.multimodalRetention?.keepRecent ?? 3;
    this.keepRecentMultimodal = Math.max(0, Math.floor(keepRecent));
  }

  /**
   * 分析上下文使用情况（粗略的 token 估算）
   */
  analyze(messages: Message[]): ContextUsage {
    const totalTokens = messages.reduce((sum, message) => {
      const blocks = message.metadata?.transport === 'omit'
        ? message.content
        : message.metadata?.content_blocks ?? message.content;
      return (
        sum +
        blocks.reduce((inner, block) => {
          if (block.type === 'text') return inner + Math.ceil(block.text.length / 4); // 粗略估算：4 chars = 1 token
          if (block.type === 'reasoning') return inner + Math.ceil(block.reasoning.length / 4);
          if (block.type === 'image' || block.type === 'audio' || block.type === 'file') {
            return inner + 500; // 固定估算，避免 base64 膨胀
          }
          return inner + Math.ceil(JSON.stringify(block).length / 4);
        }, 0)
      );
    }, 0);

    return {
      totalTokens,
      messageCount: messages.length,
      shouldCompress: totalTokens > this.maxTokens,
    };
  }

  /**
   * 压缩上下文并保存历史
   *
   * 流程：
   * 1. 保存 HistoryWindow（压缩前的完整快照）
   * 2. 执行压缩（简单版：保留后半部分 + 生成摘要）
   * 3. 保存 CompressionRecord（压缩元信息）
   * 4. 保存重要文件快照（如果有 FilePool）
   * 5. 返回压缩结果
   */
  async compress(
    messages: Message[],
    events: Timeline[],
    filePool?: FilePoolState,
    sandbox?: Sandbox
  ): Promise<CompressionResult | undefined> {
    const usage = this.analyze(messages);
    if (!usage.shouldCompress) return undefined;

    const timestamp = Date.now();
    const windowId = `window-${timestamp}`;
    const compressionId = `comp-${timestamp}`;

    // 1. 保存历史窗口
    const window: HistoryWindow = {
      id: windowId,
      messages,
      events,
      stats: {
        messageCount: messages.length,
        tokenCount: usage.totalTokens,
        eventCount: events.length,
      },
      timestamp,
    };
    await this.store.saveHistoryWindow(this.agentId, window);

    // 2. 执行压缩（简化版：保留 60% 消息）
    const targetRatio = this.compressToTokens / usage.totalTokens;
    let keepCount = Math.ceil(messages.length * Math.max(targetRatio, 0.6));
    const keepFromIndex = messages.length - keepCount;

    const multimodalKeepFrom = this.findKeepFromIndexForMultimodal(messages, this.keepRecentMultimodal);
    const finalKeepFrom = Math.min(keepFromIndex, multimodalKeepFrom);
    keepCount = messages.length - finalKeepFrom;

    const retainedMessages = messages.slice(-keepCount);
    const removedMessages = messages.slice(0, messages.length - keepCount);

    // 生成摘要
    const summaryText = this.generateSummary(removedMessages);
    const summary: Message = {
      role: 'system',
      content: [
        {
          type: 'text',
          text: `<context-summary timestamp="${new Date().toISOString()}" window="${windowId}">\n${summaryText}\n</context-summary>`,
        },
      ],
    };

    // 3. 保存压缩记录
    const recoveredPaths: string[] = [];
    if (filePool && sandbox) {
      const accessed = filePool.getAccessedFiles().slice(0, 5); // 只保存最近 5 个文件
      for (const { path, mtime } of accessed) {
        recoveredPaths.push(path);
        try {
          // 读取实际文件内容（用于上下文恢复）
          const content = await sandbox.fs.read(path);
          const file: RecoveredFile = {
            path,
            content,
            mtime,
            timestamp,
          };
          await this.store.saveRecoveredFile(this.agentId, file);
        } catch (err) {
          // 如果读取失败，保存错误信息
          const file: RecoveredFile = {
            path,
            content: `// Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
            mtime,
            timestamp,
          };
          await this.store.saveRecoveredFile(this.agentId, file);
        }
      }
    }

    const ratio = retainedMessages.length / messages.length;
    const record: CompressionRecord = {
      id: compressionId,
      windowId,
      config: {
        model: this.compressionModel,
        prompt: this.compressionPrompt,
        threshold: this.maxTokens,
      },
      summary: summaryText.slice(0, 500), // 保存摘要前 500 字符
      ratio,
      recoveredFiles: recoveredPaths,
      timestamp,
    };
    await this.store.saveCompressionRecord(this.agentId, record);

    return {
      summary,
      removedMessages,
      retainedMessages,
      windowId,
      compressionId,
      ratio,
    };
  }

  /**
   * 生成压缩摘要
   */
  private generateSummary(messages: Message[]): string {
    return messages
      .map((msg, idx) => {
        const header = `${idx + 1}. [${msg.role}]`;
        const blocks = msg.metadata?.transport === 'omit'
          ? msg.content
          : msg.metadata?.content_blocks ?? msg.content;
        const content = blocks
          .map((block) => {
            if (block.type === 'text') return block.text.slice(0, 200);
            if (block.type === 'reasoning') return `[reasoning] ${block.reasoning.slice(0, 200)}`;
            if (block.type === 'image') {
              const source = block.base64 ? 'base64' : block.url ? 'url' : block.file_id ? 'file_id' : 'unknown';
              const id = block.file_id || block.url || 'base64';
              return `[image-summary id=${id} mime=${block.mime_type || 'unknown'} note="source=${source}"]`;
            }
            if (block.type === 'audio') {
              const source = block.base64 ? 'base64' : block.url ? 'url' : block.file_id ? 'file_id' : 'unknown';
              const id = block.file_id || block.url || 'base64';
              return `[audio-summary id=${id} mime=${block.mime_type || 'unknown'} note="source=${source}"]`;
            }
            if (block.type === 'file') {
              const source = block.base64 ? 'base64' : block.url ? 'url' : block.file_id ? 'file_id' : 'unknown';
              const id = block.file_id || block.url || block.filename || 'base64';
              return `[file-summary id=${id} mime=${block.mime_type || 'unknown'} note="source=${source}"]`;
            }
            if (block.type === 'tool_use') return `[tool] ${block.name}(...)`;
            if (block.type === 'tool_result') {
              const preview = JSON.stringify(block.content).slice(0, 100);
              return `[result] ${preview}`;
            }
            return '';
          })
          .join('\n');
        return `${header}\n${content}`;
      })
      .join('\n\n');
  }

  private findKeepFromIndexForMultimodal(messages: Message[], keepRecent: number): number {
    if (keepRecent <= 0) return messages.length;
    let remaining = keepRecent;
    let earliestIndex = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const blocks = msg.metadata?.transport === 'omit'
        ? msg.content
        : msg.metadata?.content_blocks ?? msg.content;
      for (const block of blocks) {
        if (block.type === 'image' || block.type === 'audio' || block.type === 'file') {
          remaining -= 1;
          earliestIndex = i;
          if (remaining <= 0) {
            return i;
          }
        }
      }
    }
    if (earliestIndex === messages.length) {
      return messages.length;
    }
    return earliestIndex;
  }

  /**
   * 恢复历史窗口（用于审计或调试）
   */
  async loadHistory(): Promise<HistoryWindow[]> {
    return await this.store.loadHistoryWindows(this.agentId);
  }

  /**
   * 加载压缩记录
   */
  async loadCompressions(): Promise<CompressionRecord[]> {
    return await this.store.loadCompressionRecords(this.agentId);
  }

  /**
   * 加载恢复的文件
   */
  async loadRecoveredFiles(): Promise<RecoveredFile[]> {
    return await this.store.loadRecoveredFiles(this.agentId);
  }
}
