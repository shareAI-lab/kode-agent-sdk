import { ContextManager } from '../../../src/core/context-manager';
import { Store, HistoryWindow, CompressionRecord, RecoveredFile } from '../../../src/infra/store';
import { Sandbox } from '../../../src/infra/sandbox';
import { Message, Timeline } from '../../../src/core/types';
import { TestRunner, expect } from '../../helpers/utils';

class MemoryStore implements Store {
  messages = new Map<string, Message[]>();
  toolCalls = new Map<string, any[]>();
  todos = new Map<string, any>();
  events = new Map<string, Timeline[]>();
  historyWindows = new Map<string, HistoryWindow[]>();
  compressionRecords = new Map<string, CompressionRecord[]>();
  recoveredFiles = new Map<string, RecoveredFile[]>();
  mediaCache = new Map<string, any[]>();
  snapshots = new Map<string, Map<string, any>>();
  info = new Map<string, any>();

  async saveMessages(agentId: string, messages: Message[]): Promise<void> {
    this.messages.set(agentId, messages);
  }
  async loadMessages(agentId: string): Promise<Message[]> {
    return this.messages.get(agentId) || [];
  }
  async saveToolCallRecords(agentId: string, records: any[]): Promise<void> {
    this.toolCalls.set(agentId, records);
  }
  async loadToolCallRecords(agentId: string): Promise<any[]> {
    return this.toolCalls.get(agentId) || [];
  }
  async saveTodos(agentId: string, snapshot: any): Promise<void> {
    this.todos.set(agentId, snapshot);
  }
  async loadTodos(agentId: string): Promise<any | undefined> {
    return this.todos.get(agentId);
  }
  async appendEvent(agentId: string, timeline: Timeline): Promise<void> {
    const list = this.events.get(agentId) || [];
    list.push(timeline);
    this.events.set(agentId, list);
  }
  async *readEvents(agentId: string): AsyncIterable<Timeline> {
    for (const entry of this.events.get(agentId) || []) {
      yield entry;
    }
  }
  async saveHistoryWindow(agentId: string, window: HistoryWindow): Promise<void> {
    const list = this.historyWindows.get(agentId) || [];
    list.push(window);
    this.historyWindows.set(agentId, list);
  }
  async loadHistoryWindows(agentId: string): Promise<HistoryWindow[]> {
    return this.historyWindows.get(agentId) || [];
  }
  async saveCompressionRecord(agentId: string, record: CompressionRecord): Promise<void> {
    const list = this.compressionRecords.get(agentId) || [];
    list.push(record);
    this.compressionRecords.set(agentId, list);
  }
  async loadCompressionRecords(agentId: string): Promise<CompressionRecord[]> {
    return this.compressionRecords.get(agentId) || [];
  }
  async saveRecoveredFile(agentId: string, file: RecoveredFile): Promise<void> {
    const list = this.recoveredFiles.get(agentId) || [];
    list.push(file);
    this.recoveredFiles.set(agentId, list);
  }
  async loadRecoveredFiles(agentId: string): Promise<RecoveredFile[]> {
    return this.recoveredFiles.get(agentId) || [];
  }
  async saveMediaCache(agentId: string, records: any[]): Promise<void> {
    this.mediaCache.set(agentId, records);
  }
  async loadMediaCache(agentId: string): Promise<any[]> {
    return this.mediaCache.get(agentId) || [];
  }
  async saveSnapshot(agentId: string, snapshot: any): Promise<void> {
    const map = this.snapshots.get(agentId) || new Map<string, any>();
    map.set(snapshot.id, snapshot);
    this.snapshots.set(agentId, map);
  }
  async loadSnapshot(agentId: string, snapshotId: string): Promise<any | undefined> {
    return this.snapshots.get(agentId)?.get(snapshotId);
  }
  async listSnapshots(agentId: string): Promise<any[]> {
    return Array.from(this.snapshots.get(agentId)?.values() || []);
  }
  async saveInfo(agentId: string, info: any): Promise<void> {
    this.info.set(agentId, info);
  }
  async loadInfo(agentId: string): Promise<any> {
    return this.info.get(agentId);
  }
  async exists(agentId: string): Promise<boolean> {
    return this.info.has(agentId);
  }
  async delete(agentId: string): Promise<void> {
    this.messages.delete(agentId);
    this.toolCalls.delete(agentId);
    this.todos.delete(agentId);
    this.events.delete(agentId);
    this.historyWindows.delete(agentId);
    this.compressionRecords.delete(agentId);
    this.recoveredFiles.delete(agentId);
    this.snapshots.delete(agentId);
    this.info.delete(agentId);
  }
  async list(): Promise<string[]> {
    return Array.from(this.messages.keys());
  }
}

const runner = new TestRunner('ContextManager');

const baseMessage: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'hello world context testing block of text' }],
};

runner
  .test('analyze提供token估算并判断压缩需求', async () => {
    const store = new MemoryStore();
    const manager = new ContextManager(store, 'agent-1', { maxTokens: 1 });

    const usage = manager.analyze([baseMessage]);
    expect.toEqual(usage.messageCount, 1);
    expect.toEqual(usage.shouldCompress, true);
  })

  .test('compress保存历史窗口与压缩记录并生成摘要', async () => {
    const store = new MemoryStore();
    const manager = new ContextManager(store, 'agent-1', { maxTokens: 10, compressToTokens: 4 });

    const messages: Message[] = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `message ${i} with enough length to trigger compression ${'!'.repeat(40)}` }],
    }));

    const events: Timeline[] = [
      {
        cursor: 0,
        bookmark: { seq: 0, timestamp: Date.now() },
        event: { channel: 'progress', type: 'text_chunk', delta: 'hi', step: 1 },
      } as any,
    ];

    const filePool = {
      getAccessedFiles: () => [{ path: 'notes.md', mtime: Date.now() }],
    };

    const sandbox: Sandbox = {
      kind: 'local',
      fs: {
        read: async () => '# Notes',
        resolve: (p: string) => p,
        isInside: () => true,
        write: async () => {},
        temp: () => 'tmp',
        stat: async () => ({ mtimeMs: Date.now() }),
        glob: async () => [],
      },
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    };

    const result = await manager.compress(messages, events, filePool, sandbox);
    expect.toBeTruthy(result);
    const summaryBlock = result!.summary.content[0] as any;
    expect.toContain(summaryBlock.text, '<context-summary');
    expect.toBeGreaterThan(result!.removedMessages.length, 0);

    const history = await manager.loadHistory();
    expect.toEqual(history.length, 1);

    const compressions = await manager.loadCompressions();
    expect.toEqual(compressions.length, 1);
    expect.toContain(compressions[0].recoveredFiles[0], 'notes.md');

    const recovered = await manager.loadRecoveredFiles();
    expect.toEqual(recovered.length, 1);
    expect.toContain(recovered[0].content, '# Notes');
  })

  .test('压缩时保留最近N个多模态块', async () => {
    const store = new MemoryStore();
    const manager = new ContextManager(store, 'agent-3', {
      maxTokens: 1,
      compressToTokens: 1,
      multimodalRetention: { keepRecent: 2 },
    });

    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'image-1' },
          { type: 'image', url: 'http://example.com/1.png', mime_type: 'image/png' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ack-1' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'image-2' },
          { type: 'image', url: 'http://example.com/2.png', mime_type: 'image/png' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ack-2' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'image-3' },
          { type: 'image', url: 'http://example.com/3.png', mime_type: 'image/png' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ack-3' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'filler-1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'filler-2' }] },
    ];

    const result = await manager.compress(messages, [], undefined, undefined);
    expect.toBeTruthy(result);

    const retainedImages = result!.retainedMessages
      .flatMap((msg) => msg.content)
      .filter((block) => block.type === 'image')
      .map((block) => (block as any).url);

    expect.toContain(retainedImages, 'http://example.com/2.png');
    expect.toContain(retainedImages, 'http://example.com/3.png');

    const summaryText = (result!.summary.content[0] as any).text;
    expect.toContain(summaryText, '[image-summary id=http://example.com/1.png');
  })

  .test('在token足够时不会压缩', async () => {
    const store = new MemoryStore();
    const manager = new ContextManager(store, 'agent-2', { maxTokens: 10_000 });
    const result = await manager.compress([baseMessage], [], undefined, undefined);
    expect.toEqual(result, undefined);
  });

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
