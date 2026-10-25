import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Agent, AgentConfig, AgentTemplateRegistry, JSONStore, LocalSandbox, SandboxFactory, ToolRegistry } from '../../../src';
import { Message, ToolContext } from '../../../src/core/types';
import { ModelStreamChunk } from '../../../src/infra/provider';
import { ToolInstance } from '../../../src/tools/registry';
import { MockProvider } from '../../mock-provider';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('Agent lifecycle regressions');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function deadline<T>(task: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish`)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

async function* text(value: string): AsyncIterable<ModelStreamChunk> {
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } };
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_stop' };
}

async function* tools(ids = ['call-1']): AsyncIterable<ModelStreamChunk> {
  for (const [index, id] of ids.entries()) {
    yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'probe', input: {} } };
    yield { type: 'content_block_stop', index };
  }
  yield { type: 'message_stop' };
}

class ScriptedProvider extends MockProvider {
  calls = 0;
  constructor(private scenario: (call: number, messages: Message[]) => AsyncIterable<ModelStreamChunk>) { super(); }
  stream(messages: Message[]) { return this.scenario(++this.calls, messages); }
}

async function fixture(
  model: ScriptedProvider,
  options: { approval?: boolean; exec?: (args: any, ctx: ToolContext) => Promise<any> } = {}
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kode-lifecycle-'));
  const store = new JSONStore(path.join(root, 'store'), 1);
  const eventWrites = new Set<Promise<void>>();
  const appendEvent = store.appendEvent.bind(store);
  store.appendEvent = (id, entry) => {
    const write = appendEvent(id, entry);
    eventWrites.add(write);
    void write.finally(() => eventWrites.delete(write));
    return write;
  };
  const templateRegistry = new AgentTemplateRegistry();
  templateRegistry.register({
    id: 'lifecycle', systemPrompt: 'Controlled offline lifecycle test.',
    tools: options.exec ? ['probe'] : [], permission: { mode: options.approval ? 'approval' : 'auto' },
  });
  const toolRegistry = new ToolRegistry();
  if (options.exec) {
    const probe: ToolInstance = {
      name: 'probe', description: 'Controlled test tool', input_schema: { type: 'object' }, exec: options.exec,
      toDescriptor: () => ({ source: 'registered', name: 'probe', registryId: 'probe' }),
    };
    toolRegistry.register('probe', () => probe);
  }
  const deps = { store, templateRegistry, toolRegistry, sandboxFactory: new SandboxFactory(), modelFactory: () => model };
  const config: AgentConfig = {
    templateId: 'lifecycle', model, metadata: { maxToolConcurrency: 1 },
    sandbox: { kind: 'local', workDir: root, watchFiles: false, enforceBoundary: true },
  };
  const agent = await Agent.create(config, deps);
  const instances = [agent];
  const releases: Array<() => void> = [];
  return {
    agent, deps, config, root, instances, releases,
    async close() {
      releases.forEach(release => release());
      for (const instance of instances) {
        const internal = instance as any;
        for (const pending of internal.pendingPermissions.values()) pending.resolve('deny');
        for (const subscribers of internal.events.subscribers.values()) {
          for (const subscriber of subscribers) subscriber.close();
        }
        await deadline(Promise.resolve(internal.processingPromise), 'test cleanup').catch(() => undefined);
        await internal.sandbox.dispose?.();
      }
      await Promise.all(eventWrites);
      for await (const _entry of store.readEvents(agent.agentId)) { /* Drain buffered event writers. */ }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

runner.test('filtered streams terminate and release their subscriber', async () => {
  const ctx = await fixture(new ScriptedProvider(() => text('hello')));
  try {
    const events: string[] = [];
    await deadline((async () => {
      for await (const envelope of ctx.agent.chatStream('first', { kinds: ['text_chunk'] })) events.push(envelope.event.type);
    })(), 'filtered stream');
    expect.toDeepEqual(events, ['text_chunk']);
    expect.toEqual((ctx.agent as any).events.subscribers.get('progress').size, 0);
    expect.toEqual((await ctx.agent.status()).state, 'READY');
  } finally { await ctx.close(); }
});

runner.test('model errors reject instead of returning the previous successful reply', async () => {
  const model = new ScriptedProvider(call => call === 1 ? text('old reply') : (async function* () { throw new Error('provider failed'); })());
  const ctx = await fixture(model);
  try {
    await deadline(ctx.agent.chat('first'), 'first reply');
    await deadline(Promise.resolve((ctx.agent as any).processingPromise), 'first persistence');
    await expect.toThrow(async () => { await deadline(ctx.agent.chat('second'), 'failed reply'); }, 'provider failed');
    expect.toEqual((await ctx.agent.status()).state, 'READY');
  } finally { await ctx.close(); }
});

runner.test('a slow consumer finishes its own turn while a later send is still running', async () => {
  const gate = deferred();
  const started = deferred();
  const model = new ScriptedProvider(call => call === 1 ? text('first') : (async function* () {
    started.resolve(); await gate.promise; yield* text('second');
  })());
  const ctx = await fixture(model);
  ctx.releases.push(gate.resolve);
  const iterator = ctx.agent.chatStream('first')[Symbol.asyncIterator]();
  try {
    let event = await deadline(iterator.next(), 'first event');
    while (!event.done && event.value.event.type !== 'text_chunk') event = await deadline(iterator.next(), 'first text');
    await deadline(Promise.resolve((ctx.agent as any).processingPromise), 'first turn persistence');
    await ctx.agent.send('second');
    await deadline(started.promise, 'second model start');
    await deadline((async () => { while (!(await iterator.next()).done) {} })(), 'slow first consumer');
    expect.toEqual(model.calls, 2);
    expect.toEqual((await ctx.agent.status()).state, 'WORKING');
  } finally { gate.resolve(); await iterator.return?.(); await ctx.close(); }
});

runner.test('sending after the timeout threshold does not start overlapping model work', async () => {
  const gate = deferred();
  const started = deferred();
  const model = new ScriptedProvider(call => call === 1 ? (async function* () {
    started.resolve(); await gate.promise; yield* text('first');
  })() : text('second'));
  const ctx = await fixture(model);
  ctx.releases.push(gate.resolve);
  try {
    const first = ctx.agent.chat('first');
    await deadline(started.promise, 'first model start');
    (ctx.agent as any).lastProcessingStart = Date.now() - 6 * 60 * 1000;
    await ctx.agent.send('second');
    expect.toEqual(model.calls, 1);
    gate.resolve();
    await deadline(first, 'first model completion');
    await deadline(Promise.resolve((ctx.agent as any).processingPromise), 'queued turn completion');
    expect.toEqual(model.calls, 2);
  } finally { gate.resolve(); await ctx.close(); }
});

runner.test('immediate approval executes in WORKING state and continues exactly once', async () => {
  const model = new ScriptedProvider(call => call === 1 ? tools() : text('approved'));
  const states: string[] = [];
  const ctx = await fixture(model, { approval: true, exec: async (_args, context) => {
    states.push((await context.agent.status()).state); return { ok: true };
  } });
  const off = ctx.agent.on('permission_required', event => { void event.respond('allow'); });
  try {
    const result = await deadline(ctx.agent.chat('use probe'), 'approved turn');
    expect.toDeepEqual(states, ['WORKING']);
    expect.toEqual(result.text, 'approved');
    expect.toEqual(model.calls, 2);
  } finally { off(); await ctx.close(); }
});

runner.test('denying approval returns a tool result without executing the tool', async () => {
  let executions = 0;
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? tools() : text('denied')), {
    approval: true, exec: async () => { executions++; return { ok: true }; },
  });
  const off = ctx.agent.on('permission_required', event => { void event.respond('deny'); });
  try {
    const result = await deadline(ctx.agent.chat('use probe'), 'denied turn');
    expect.toEqual(executions, 0);
    expect.toEqual(result.text, 'denied');
    expect.toEqual((await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId))[0].state, 'DENIED');
  } finally { off(); await ctx.close(); }
});

runner.test('interrupting a pending approval settles the turn and records the denial', async () => {
  const requested = deferred();
  let executions = 0;
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? tools() : text('next')), {
    approval: true, exec: async () => { executions++; return {}; },
  });
  const decisions: string[] = [];
  const off = ctx.agent.on('permission_required', () => requested.resolve());
  const offDecision = ctx.agent.on('permission_decided', event => decisions.push(event.decision));
  try {
    const pending = ctx.agent.chat('needs approval');
    await deadline(requested.promise, 'permission request');
    await ctx.agent.interrupt();
    expect.toEqual((await deadline(pending, 'interrupted approval')).status, 'paused');
    expect.toDeepEqual(decisions, ['deny']);
    expect.toEqual(executions, 0);
    expect.toEqual((await deadline(ctx.agent.chat('next'), 'next turn')).text, 'next');
  } finally { off(); offDecision(); await ctx.close(); }
});

runner.test('interrupting an idle agent does not discard its next message', async () => {
  const model = new ScriptedProvider(() => text('after idle interrupt'));
  const ctx = await fixture(model);
  try {
    await ctx.agent.interrupt();
    expect.toEqual((await deadline(ctx.agent.chat('next'), 'next after idle interrupt')).text, 'after idle interrupt');
    expect.toEqual(model.calls, 1);
  } finally { await ctx.close(); }
});

runner.test('interrupt during streaming drops later chunks and allows the next turn', async () => {
  const gate = deferred();
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? (async function* () {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as ModelStreamChunk;
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } } as ModelStreamChunk;
    await gate.promise;
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cancelled suffix' } } as ModelStreamChunk;
  })() : text('next')));
  ctx.releases.push(gate.resolve);
  const iterator = ctx.agent.chatStream('stream')[Symbol.asyncIterator]();
  try {
    let item = await deadline(iterator.next(), 'stream start');
    while (!item.done && item.value.event.type !== 'text_chunk') item = await deadline(iterator.next(), 'partial text');
    await ctx.agent.interrupt(); gate.resolve();
    const remaining: any[] = [];
    await deadline((async () => {
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) remaining.push(next.value.event);
    })(), 'interrupted stream');
    expect.toEqual(remaining.filter(event => event.type === 'text_chunk').length, 0);
    expect.toEqual(remaining.find(event => event.type === 'done')?.reason, 'interrupted');
    expect.toEqual((await deadline(ctx.agent.chat('next'), 'next after stream interrupt')).text, 'next');
  } finally { gate.resolve(); await iterator.return?.(); await ctx.close(); }
});

runner.test('multi-tool cancellation settles queued work and seals records before resume', async () => {
  const started = deferred();
  let executions = 0;
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? tools(['one', 'two', 'three']) : text('resumed')), {
    exec: async (_args, context) => {
      executions++; started.resolve();
      await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => resolve(), { once: true }));
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  });
  try {
    const pending = ctx.agent.chat('three tools');
    await deadline(started.promise, 'first tool start');
    await ctx.agent.interrupt();
    expect.toEqual((await deadline(pending, 'cancelled tools')).status, 'paused');
    expect.toEqual(executions, 1);
    const records = await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId);
    expect.toDeepEqual(records.map(record => record.state), ['SEALED', 'SEALED', 'SEALED']);
    const resumed = await Agent.resumeFromStore(ctx.agent.agentId, ctx.deps, { strategy: 'crash', autoRun: false });
    ctx.instances.push(resumed);
    expect.toEqual((await deadline(resumed.chat('continue'), 'resumed after tools')).text, 'resumed');
    expect.toEqual(executions, 1);
  } finally { await ctx.close(); }
});

runner.test('terminal metadata persistence failure rejects even after done has been emitted', async () => {
  const ctx = await fixture(new ScriptedProvider(() => text('answer')));
  const save = ctx.deps.store.saveInfo.bind(ctx.deps.store);
  ctx.deps.store.saveInfo = async (id, info) => {
    if (info.lastBookmark) throw new Error('terminal metadata write failed');
    await save(id, info);
  };
  try {
    await expect.toThrow(async () => { await deadline(ctx.agent.chat('first'), 'failed terminal write'); }, 'terminal metadata write failed');
    expect.toEqual((await ctx.agent.status()).state, 'READY');
  } finally { ctx.deps.store.saveInfo = save; await ctx.close(); }
});

runner.test('resume applies explicit model, sandbox and permission overrides while keeping history', async () => {
  const ctx = await fixture(new ScriptedProvider(() => text('original')));
  const replacement = new LocalSandbox({ workDir: ctx.root, enforceBoundary: true, allowPaths: [os.tmpdir()], watchFiles: false });
  try {
    await deadline(ctx.agent.chat('keep history'), 'original turn');
    await deadline(Promise.resolve((ctx.agent as any).processingPromise), 'original persistence');
    const model = new ScriptedProvider((_call, messages) => text(messages.some(message => message.content.some(
      block => block.type === 'text' && block.text === 'keep history'
    )) ? 'override with history' : 'history missing'));
    const resumed = await Agent.resumeFromStore(ctx.agent.agentId, ctx.deps, { autoRun: false, overrides: {
      model, sandbox: replacement, overrides: { permission: { mode: 'readonly' } },
    } });
    ctx.instances.push(resumed);
    expect.toEqual((resumed as any).sandbox, replacement);
    expect.toEqual((resumed as any).permission.mode, 'readonly');
    expect.toEqual((await deadline(resumed.chat('continue'), 'overridden resume')).text, 'override with history');
    const again = await Agent.resumeFromStore(ctx.agent.agentId, ctx.deps, { autoRun: false });
    ctx.instances.push(again);
    expect.toDeepEqual((again as any).sandbox.toConfig(), replacement.toConfig());
  } finally { await replacement.dispose(); await ctx.close(); }
});

runner.test('resume uses an explicit modelConfig instead of the stored model config', async () => {
  const ctx = await fixture(new ScriptedProvider(() => text('original')));
  try {
    let selected = '';
    ctx.deps.modelFactory = (config?: any) => { selected = config.model; return new ScriptedProvider(() => text(selected)); };
    const resumed = await Agent.resumeFromStore(ctx.agent.agentId, ctx.deps, {
      autoRun: false, overrides: { modelConfig: { provider: 'mock', model: 'replacement' } },
    });
    ctx.instances.push(resumed);
    expect.toEqual((await deadline(resumed.chat('continue'), 'model config override')).text, 'replacement');
  } finally { await ctx.close(); }
});

runner.test('nonserializable sandbox instances require an explicit instance when resumed', async () => {
  const ctx = await fixture(new ScriptedProvider(() => text('original')));
  try {
    const sandbox = (ctx.agent as any).sandbox;
    const custom = { kind: sandbox.kind, workDir: sandbox.workDir, fs: sandbox.fs, exec: sandbox.exec.bind(sandbox) };
    const resumed = await Agent.resumeFromStore(ctx.agent.agentId, ctx.deps, { autoRun: false, overrides: { sandbox: custom } });
    ctx.instances.push(resumed);
    await expect.toThrow(async () => { await Agent.resumeFromStore(ctx.agent.agentId, ctx.deps); }, 'explicit sandbox instance');
  } finally { await ctx.close(); }
});

export async function run() { return runner.run(); }
