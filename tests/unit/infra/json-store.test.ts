import fs from 'fs';
import path from 'path';
import { JSONStore } from '../../../src/infra/store';
import { Message } from '../../../src/core/types';
import { TestRunner, expect } from '../../helpers/utils';
import { TEST_ROOT } from '../../helpers/fixtures';

const runner = new TestRunner('JSONStore');

function createDir(name: string): string {
  const dir = path.join(TEST_ROOT, 'json-store', `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sampleMessage: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
};

runner
  .test('保存与加载运行时数据', async () => {
    const dir = createDir('runtime');
    const store = new JSONStore(dir);

    await store.saveMessages('agent', [sampleMessage]);
    const loadedMessages = await store.loadMessages('agent');
    expect.toEqual(loadedMessages.length, 1);

    const now = Date.now();
    await store.saveToolCallRecords('agent', [
      {
        id: 'tool-1',
        name: 'fs_read',
        input: {},
        state: 'COMPLETED',
        approval: { required: false },
        result: { ok: true },
        createdAt: now,
        updatedAt: now,
        auditTrail: [],
      },
    ]);
    const records = await store.loadToolCallRecords('agent');
    expect.toEqual(records.length, 1);

    await store.saveTodos('agent', { todos: [], version: 1, updatedAt: Date.now() });
    const todos = await store.loadTodos('agent');
    expect.toBeTruthy(todos);
  })

  .test('事件流Append并可读取', async () => {
    const dir = createDir('events');
    const store = new JSONStore(dir);
    const event = {
      cursor: 0,
      bookmark: { seq: 0, timestamp: Date.now() },
      event: { channel: 'progress', type: 'text_chunk', delta: 'hello', step: 1 },
    } as any;

    await store.appendEvent('agent', event);

    const events: any[] = [];
    for await (const entry of store.readEvents('agent')) {
      events.push(entry);
    }

    expect.toEqual(events.length, 1);
    expect.toEqual(events[0].event.type, 'text_chunk');
  })

  .test('历史窗口与压缩记录持久化', async () => {
    const dir = createDir('history');
    const store = new JSONStore(dir);
    const timestamp = Date.now();

    await store.saveHistoryWindow('agent', {
      id: 'window',
      messages: [sampleMessage],
      events: [],
      stats: { messageCount: 1, eventCount: 0, tokenCount: 10 },
      timestamp,
    });

    const windows = await store.loadHistoryWindows('agent');
    expect.toEqual(windows.length, 1);

    await store.saveCompressionRecord('agent', {
      id: 'comp',
      windowId: 'window',
      config: { model: 'mock', prompt: 'summary', threshold: 100 },
      summary: 'summary',
      ratio: 0.5,
      recoveredFiles: [],
      timestamp,
    });

    const records = await store.loadCompressionRecords('agent');
    expect.toEqual(records.length, 1);

    await store.saveRecoveredFile('agent', {
      path: 'note.md',
      content: '# note',
      mtime: timestamp,
      timestamp,
    });

    const recovered = await store.loadRecoveredFiles('agent');
    expect.toEqual(recovered.length, 1);
  })

  .test('快照与元信息管理', async () => {
    const dir = createDir('meta');
    const store = new JSONStore(dir);

    await store.saveSnapshot('agent', {
      id: 'snap-1',
      createdAt: Date.now(),
      metadata: {},
      messages: [sampleMessage],
    } as any);

    const snapshot = await store.loadSnapshot('agent', 'snap-1');
    expect.toBeTruthy(snapshot);

    await store.saveInfo('agent', {
      agentId: 'agent',
      templateId: 'tpl',
      createdAt: new Date().toISOString(),
      lineage: [],
      configVersion: 'test',
      messageCount: 0,
      lastSfpIndex: 0,
      metadata: {},
    });
    const info = await store.loadInfo('agent');
    expect.toEqual(info?.templateId, 'tpl');

    expect.toEqual(await store.exists('agent'), true);
    expect.toContain((await store.list()).join(','), 'agent');

    await store.delete('agent');
    expect.toEqual(await store.exists('agent'), false);
  })

  .test('exists() returns false when directory exists but meta.json is missing', async () => {
    const dir = createDir('exists-no-meta');
    const store = new JSONStore(dir);
    // Create agent directory without meta.json
    fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
    expect.toEqual(await store.exists('agent'), false);
  })

  .test('exists() returns false when meta.json is corrupted JSON', async () => {
    const dir = createDir('exists-corrupt');
    const store = new JSONStore(dir);
    const agentDir = path.join(dir, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'meta.json'), '{not valid json!!!', 'utf-8');
    expect.toEqual(await store.exists('agent'), false);
  })

  .test('exists() returns false when meta.json lacks metadata field', async () => {
    const dir = createDir('exists-no-metadata');
    const store = new JSONStore(dir);
    const agentDir = path.join(dir, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'meta.json'),
      JSON.stringify({ agentId: 'agent', templateId: 'tpl' }),
      'utf-8'
    );
    expect.toEqual(await store.exists('agent'), false);
  })

  .test('exists() returns true when meta.json is complete', async () => {
    const dir = createDir('exists-complete');
    const store = new JSONStore(dir);
    await store.saveInfo('agent', {
      agentId: 'agent',
      templateId: 'tpl',
      createdAt: new Date().toISOString(),
      lineage: [],
      configVersion: 'test',
      messageCount: 0,
      lastSfpIndex: 0,
      metadata: { templateId: 'tpl' },
    });
    expect.toEqual(await store.exists('agent'), true);
  });

runner.test('metadata remains readable while a replacement is being written', async () => {
  const dir = createDir('meta-atomic');
  const store = new JSONStore(dir);
  const initial = { agentId: 'agent', templateId: 'tpl', createdAt: new Date().toISOString(), lineage: [], configVersion: 'test', messageCount: 0, lastSfpIndex: 0, metadata: {} };
  await store.saveInfo('agent', initial);
  const write = (store as any).writeFileSafe.bind(store);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writing = new Promise<void>((resolve) => { started = resolve; });
  (store as any).writeFileSafe = async (file: string, data: string) => {
    await write(file, '');
    started();
    await gate;
    await write(file, data);
  };
  const replacement = store.saveInfo('agent', { ...initial, messageCount: 1 });
  try {
    await writing;
    const visible = await store.loadInfo('agent');
    const exists = await store.exists('agent');
    release();
    await replacement;
    expect.toEqual(visible?.messageCount, 0);
    expect.toEqual(exists, true);
    expect.toEqual((await store.loadInfo('agent'))?.messageCount, 1);
  } finally {
    release();
    await replacement.catch(() => undefined);
    (store as any).writeFileSafe = write;
  }
});

runner.test('failed metadata replacement preserves the last complete snapshot', async () => {
  const dir = createDir('meta-failure');
  const store = new JSONStore(dir);
  const initial = { agentId: 'agent', templateId: 'tpl', createdAt: new Date().toISOString(), lineage: [], configVersion: 'test', messageCount: 0, lastSfpIndex: 0, metadata: {} };
  await store.saveInfo('agent', initial);
  const write = (store as any).writeFileSafe.bind(store);
  (store as any).writeFileSafe = async (file: string) => { await write(file, ''); throw new Error('disk full'); };
  try {
    await expect.toThrow(() => store.saveInfo('agent', { ...initial, messageCount: 1 }));
  } finally { (store as any).writeFileSafe = write; }
  expect.toEqual((await store.loadInfo('agent'))?.messageCount, 0);
  expect.toEqual(await store.exists('agent'), true);
  expect.toEqual(fs.readdirSync(path.join(dir, 'agent')).filter(file => file.endsWith('.tmp')).length, 0);
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
