import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Agent, AgentTemplateRegistry, JSONStore, LocalSandbox, SandboxFactory, ToolRegistry, toolDecorator, extractTools } from '@shareai-lab/kode-sdk';
import { MockProvider } from '../../../examples/shared/mock-provider';
import { runGettingStarted } from '../../../examples/getting-started';
import { runSchedulerWatch } from '../../../examples/04-scheduler-watch';
import type { Message } from '../../../src';
import { TestRunner } from '../../helpers/utils';

const runner = new TestRunner('Public package onboarding');

runner.test('the model example exits clearly when run without credentials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kode-no-key-'));
  try {
    const root = path.resolve(__dirname, '../../..');
    const result = spawnSync(process.execPath, [
      path.join(root, 'node_modules/ts-node/dist/bin.js'), '--project', path.join(root, 'tsconfig.json'),
      path.join(root, 'examples/getting-started.ts'),
    ], { cwd: directory, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Set ANTHROPIC_API_KEY, or use --mock/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

runner.test('the executable getting-started example runs with a public custom provider', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kode-example-'));
  try {
    const chunks: string[] = [];
    const result = await runGettingStarted(new MockProvider('offline response'), {
      workDir: directory, storeDir: path.join(directory, 'store'), write: chunk => chunks.push(chunk),
    });
    assert.equal(result, 'offline response');
    assert.equal(chunks.join(''), result);
  } finally {
    // JSONStore event writers finish independently of the turn's metadata write.
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

runner.test('the scheduler example injects reminders without extra model turns and finishes cleanly', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kode-scheduler-example-'));
  const prompts: string[] = [];
  const reminders: boolean[] = [];
  const logs: string[] = [];
  class SchedulerModel extends MockProvider {
    async *stream(messages: Message[]) {
      const latest = [...messages].reverse().find(message => message.role === 'user');
      prompts.push(latest!.content.filter(block => block.type === 'text').map(block => block.text).join(''));
      reminders.push(messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('系统提醒：请总结'))));
      yield* super.stream(messages);
    }
  }
  try {
    await runSchedulerWatch(new SchedulerModel(), {
      workDir: directory, storeDir: path.join(directory, 'store'), log: message => logs.push(message),
    });
    assert.equal(prompts.length, 3);
    assert.match(prompts[1], /根据刚才的输出/);
    assert.match(prompts[2], /监控 docs/);
    assert.deepEqual(reminders, [false, true, true]);
    assert.equal(logs.filter(message => message.startsWith('[scheduler]')).length, 2);
    assert.match(logs.at(-1)!, /completed/);
  } finally {
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

runner.test('the decorator is exported without replacing the tool builder', async () => {
  class Calculator { async sum(args: { a: number; b: number }) { return args.a + args.b; } }
  toolDecorator({ description: 'Add', params: { a: { type: 'number' }, b: { type: 'number' } } })(
    Calculator.prototype, 'sum', Object.getOwnPropertyDescriptor(Calculator.prototype, 'sum')!
  );
  const instances = extractTools(new Calculator());
  assert.equal(instances.length, 1);
  assert.equal(instances[0].name, 'sum');
});

runner.test('a public raw subscription consumes concurrently with send and closes at done', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kode-inbox-'));
  const store = new JSONStore(path.join(directory, 'store'));
  const sandbox = new LocalSandbox({ workDir: directory, watchFiles: false });
  let timer: NodeJS.Timeout | undefined;
  const templates = new AgentTemplateRegistry();
  templates.register({ id: 'inbox', systemPrompt: 'Offline inbox test' });
  const agent = await Agent.create({ templateId: 'inbox', model: new MockProvider('reply'), sandbox }, {
    store, templateRegistry: templates, toolRegistry: new ToolRegistry(), sandboxFactory: new SandboxFactory(),
  });
  const iterator = agent.subscribe(['progress'])[Symbol.asyncIterator]();
  try {
    const events: string[] = [];
    const consume = (async () => {
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        events.push(next.value.event.type);
        if (next.value.event.type === 'done') break;
      }
    })();
    assert.match(await agent.send('hello'), /^msg-/);
    await Promise.race([consume, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('raw subscription did not finish')), 3000);
    })]);
    assert.ok(events.includes('text_chunk'));
  } finally {
    clearTimeout(timer);
    await iterator.return?.();
    await sandbox.dispose();
    await new Promise(resolve => setTimeout(resolve, 100));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

export async function run() { return runner.run(); }
