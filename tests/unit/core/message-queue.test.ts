import { MessageQueue } from '../../../src/core/agent/message-queue';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('MessageQueue');

runner
  .test('发送用户消息会立即触发处理并持久化', async () => {
    const operations: Array<{ op: string; payload?: any }> = [];
    const queue = new MessageQueue({
      wrapReminder: (text) => `REMINDER:${text}`,
      addMessage: (message, kind) => {
        operations.push({ op: 'add', payload: { message, kind } });
      },
      persist: async () => {
        operations.push({ op: 'persist' });
      },
      ensureProcessing: () => {
        operations.push({ op: 'process' });
      },
    });

    const messageId = queue.send('hello world');
    expect.toBeTruthy(messageId);

    await queue.flush();

    expect.toEqual(operations[0].op, 'process');
    expect.toEqual(operations[1].op, 'add');
    expect.toEqual(operations[1].payload.kind, 'user');
    expect.toEqual(operations[2].op, 'persist');
  })

  .test('提醒消息不会触发处理但会包裹内容', async () => {
    const added: any[] = [];
    const queue = new MessageQueue({
      wrapReminder: (text) => `REMINDER:${text}`,
      addMessage: (message, kind) => {
        added.push({ message, kind });
      },
      persist: async () => {},
      ensureProcessing: () => {
        throw new Error('should not be called');
      },
    });

    queue.send('tick', { kind: 'reminder', metadata: { foo: 1 } });
    await queue.flush();

    expect.toHaveLength(added, 1);
    expect.toEqual(added[0].kind, 'reminder');
    expect.toContain(added[0].message.content[0].text, 'REMINDER:tick');
  })

  .test('flush失败会保留队列', async () => {
    let attempts = 0;
    const queue = new MessageQueue({
      wrapReminder: (text) => text,
      addMessage: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('transient failure');
        }
      },
      persist: async () => {},
      ensureProcessing: () => {},
    });

    queue.send('first');

    await expect.toThrow(async () => {
      await queue.flush();
    });

    // 第二次执行应继续处理
    await queue.flush();
    expect.toEqual(attempts >= 2, true);
  })

  .test('多轮 flush 会保持顺序并处理混合消息', async () => {
    const added: Array<{ kind: string; text: string; cycle: number }> = [];
    let cycle = 0;
    let processingCalls = 0;

    const queue = new MessageQueue({
      wrapReminder: (text, options) => {
        const priority = options?.priority ?? 'normal';
        return `[priority:${priority}] ${text}`;
      },
      addMessage: (message, kind) => {
        const content = (message.content as any) || [];
        const text = typeof content[0]?.text === 'string' ? content[0].text : '';
        added.push({ kind, text, cycle });
      },
      persist: async () => {
        cycle += 1;
      },
      ensureProcessing: () => {
        processingCalls += 1;
      },
    });

    const firstUserId = queue.send('user-1');
    const reminderId = queue.send('reminder-1', {
      kind: 'reminder',
      reminder: { priority: 'high' },
    });
    const secondUserId = queue.send('user-2');

    expect.toBeTruthy(firstUserId);
    expect.toBeTruthy(reminderId);
    expect.toBeTruthy(secondUserId);
    expect.toEqual(processingCalls, 2);

    await queue.flush();

    expect.toEqual(cycle, 1);
    expect.toDeepEqual(
      added.map(({ kind, text }) => ({ kind, text })),
      [
        { kind: 'user', text: 'user-1' },
        { kind: 'reminder', text: '[priority:high] reminder-1' },
        { kind: 'user', text: 'user-2' },
      ]
    );

    processingCalls = 0;

    queue.send('user-3');
    queue.send('reminder-2', {
      kind: 'reminder',
      reminder: { priority: 'low' },
    });

    expect.toEqual(processingCalls, 1);

    await queue.flush();

    expect.toEqual(cycle, 2);
    expect.toDeepEqual(
      added.map(({ kind, text }) => ({ kind, text })),
      [
        { kind: 'user', text: 'user-1' },
        { kind: 'reminder', text: '[priority:high] reminder-1' },
        { kind: 'user', text: 'user-2' },
        { kind: 'user', text: 'user-3' },
        { kind: 'reminder', text: '[priority:low] reminder-2' },
      ]
    );

    const previousAdds = added.length;
    await queue.flush();
    expect.toEqual(added.length, previousAdds);
  });

runner.test('持久化期间新入队的消息保留到下一轮 flush', async () => {
  const added: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  const queue = new MessageQueue({
    wrapReminder: text => text,
    addMessage: message => added.push((message.content[0] as any).text),
    persist: async () => { if (++writes === 1) await gate; },
    ensureProcessing: () => {},
  });
  queue.send('first');
  const flushing = queue.flush();
  queue.send('second');
  release();
  await flushing;
  await queue.flush();
  expect.toDeepEqual(added, ['first', 'second']);
  expect.toEqual(writes, 2);
});

runner.test('持久化失败重试不会重复追加已加入历史的消息', async () => {
  const added: string[] = [];
  let writes = 0;
  const queue = new MessageQueue({
    wrapReminder: text => text,
    addMessage: message => added.push((message.content[0] as any).text),
    persist: async () => { if (++writes === 1) throw new Error('temporary store failure'); },
    ensureProcessing: () => {},
  });
  queue.send('first');
  await expect.toThrow(() => queue.flush());
  queue.send('second');
  await queue.flush();
  expect.toDeepEqual(added, ['first', 'second']);
  expect.toEqual(writes, 2);
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
