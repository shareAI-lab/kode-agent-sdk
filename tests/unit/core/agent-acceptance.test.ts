import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fork } from 'child_process';
import { Agent, AgentTemplateRegistry, FsRead, FsWrite, JSONStore, OpenAIProvider, SandboxFactory, ToolRegistry } from '../../../src';
import { ModelStreamChunk } from '../../../src/infra/provider';
import { TestRunner, expect } from '../../helpers/utils';
import { ScriptedProvider, fixture, text, deferred, deadline } from './agent-lifecycle.test';

const runner = new TestRunner('Expanded SDK acceptance (offline)');

async function* calls(entries: Array<{ id: string; name?: string; input?: any }>): AsyncIterable<ModelStreamChunk> {
  for (const [index, entry] of entries.entries()) {
    yield { type: 'content_block_start', index, content_block: {
      type: 'tool_use', id: entry.id, name: entry.name ?? 'probe', input: entry.input ?? {},
    } };
    yield { type: 'content_block_stop', index };
  }
  yield { type: 'message_stop' };
}

runner.test('validated tool arguments reach the executor exactly once', async () => {
  const seen: any[] = [];
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? calls([{ id: 'valid', input: { count: 3 } }]) : text('done')), {
    schema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false },
    exec: async args => { seen.push(args); return { count: args.count }; },
  });
  try {
    expect.toEqual((await deadline(ctx.agent.chat('use tool'), 'validated tool')).text, 'done');
    expect.toDeepEqual(seen, [{ count: 3 }]);
    expect.toEqual((await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId))[0].state, 'COMPLETED');
  } finally { await ctx.close(); }
});

runner.test('invalid tool arguments fail before execution and return an error to the model', async () => {
  let executed = 0;
  let receivedError = false;
  const ctx = await fixture(new ScriptedProvider((call, messages) => {
    if (call === 1) return calls([{ id: 'invalid', input: { count: 'wrong' } }]);
    receivedError = messages.some(message => message.content.some(block => block.type === 'tool_result' && block.is_error));
    return text('recovered');
  }), { schema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }, exec: async () => { executed++; return {}; } });
  try {
    await deadline(ctx.agent.chat('invalid arguments'), 'invalid tool');
    expect.toEqual(executed, 0);
    expect.toEqual(receivedError, true);
    expect.toEqual((await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId))[0].state, 'FAILED');
    expect.toDeepEqual((ctx.agent as any).events.getTimeline().filter((entry: any) => ['tool:start', 'tool:end'].includes(entry.event.type))
      .map((entry: any) => [entry.event.type, entry.event.call.state]), [['tool:start', 'PENDING'], ['tool:end', 'FAILED']]);
  } finally { await ctx.close(); }
});

runner.test('missing tools produce a failed record without hanging the turn', async () => {
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? calls([{ id: 'missing', name: 'not_registered' }]) : text('handled')));
  try {
    expect.toEqual((await deadline(ctx.agent.chat('missing tool'), 'missing tool')).text, 'handled');
    expect.toEqual((await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId))[0].state, 'FAILED');
    expect.toDeepEqual((ctx.agent as any).events.getTimeline().filter((entry: any) => ['tool:start', 'tool:end'].includes(entry.event.type))
      .map((entry: any) => [entry.event.type, entry.event.call.state]), [['tool:start', 'PENDING'], ['tool:end', 'FAILED']]);
  } finally { await ctx.close(); }
});

runner.test('tool exceptions become failed tool results and permit the next model turn', async () => {
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? calls([{ id: 'throw' }]) : text('handled')), {
    exec: async () => { throw new Error('controlled tool failure'); },
  });
  try {
    expect.toEqual((await deadline(ctx.agent.chat('failing tool'), 'tool failure')).text, 'handled');
    const [record] = await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId);
    expect.toEqual(record.state, 'FAILED');
    expect.toContain(record.error!, 'controlled tool failure');
  } finally { await ctx.close(); }
});

runner.test('parallel tools keep request order even when their completion order differs', async () => {
  const first = deferred();
  let active = 0, peak = 0;
  const order: string[] = [];
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? calls([
    { id: 'one', input: { id: 'one' } }, { id: 'two', input: { id: 'two' } },
  ]) : text('done')), { concurrency: 2, exec: async args => {
    peak = Math.max(peak, ++active);
    if (args.id === 'one') await first.promise;
    else first.resolve();
    order.push(args.id); active--;
    return args.id;
  } });
  ctx.releases.push(first.resolve);
  try {
    await deadline(ctx.agent.chat('parallel tools'), 'parallel tools');
    expect.toEqual(peak, 2);
    expect.toDeepEqual(order, ['two', 'one']);
    const history = await ctx.deps.store.loadMessages(ctx.agent.agentId);
    const ids = history.flatMap(message => message.content).filter(block => block.type === 'tool_result').map(block => (block as any).tool_use_id);
    expect.toDeepEqual(ids, ['one', 'two']);
  } finally { first.resolve(); await ctx.close(); }
});

runner.test('tool timeout aborts cooperative execution and records the failure', async () => {
  let aborted = false;
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? calls([{ id: 'timeout' }]) : text('after timeout')), {
    timeoutMs: 20, exec: async (_args, context) => {
      await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      throw Object.assign(new Error('timeout abort'), { name: 'AbortError' });
    },
  });
  try {
    expect.toEqual((await deadline(ctx.agent.chat('slow tool'), 'tool timeout')).text, 'after timeout');
    expect.toEqual(aborted, true);
    expect.toEqual((await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId))[0].state, 'FAILED');
  } finally { await ctx.close(); }
});

runner.test('application approval deadline denies exactly once without executing the tool', async () => {
  let executions = 0, decisions = 0;
  let timer: NodeJS.Timeout | undefined;
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? calls([{ id: 'approval-timeout' }]) : text('denied by deadline')), {
    approval: true, exec: async () => { executions++; return {}; },
  });
  const off = ctx.agent.on('permission_required', event => {
    timer = setTimeout(() => { void event.respond('deny', { note: 'application deadline' }); }, 20);
  });
  const offDecision = ctx.agent.on('permission_decided', () => { decisions++; });
  try {
    expect.toEqual((await deadline(ctx.agent.chat('approval timeout'), 'approval deadline')).text, 'denied by deadline');
    expect.toEqual(executions, 0);
    expect.toEqual(decisions, 1);
    expect.toEqual((await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId))[0].approval?.note, 'application deadline');
  } finally { clearTimeout(timer); off(); offDecision(); await ctx.close(); }
});

runner.test('interrupt settles multiple outstanding approvals with one denial per call', async () => {
  const requested = deferred();
  let requests = 0, executions = 0;
  const decisions: string[] = [];
  const ctx = await fixture(new ScriptedProvider(() => calls([{ id: 'one' }, { id: 'two' }])), {
    approval: true, concurrency: 2, exec: async () => { executions++; return {}; },
  });
  const off = ctx.agent.on('permission_required', () => { if (++requests === 2) requested.resolve(); });
  const offDecision = ctx.agent.on('permission_decided', event => decisions.push(`${event.callId}:${event.decision}`));
  try {
    const chat = ctx.agent.chat('two approvals');
    await deadline(requested.promise, 'two permission requests');
    await ctx.agent.interrupt();
    expect.toEqual((await deadline(chat, 'cancel two approvals')).status, 'paused');
    expect.toEqual(executions, 0);
    expect.toDeepEqual(decisions.sort(), ['one:deny', 'two:deny']);
    expect.toDeepEqual((await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId)).map(record => record.state), ['SEALED', 'SEALED']);
  } finally { off(); offDecision(); await ctx.close(); }
});

runner.test('readonly policy blocks a real filesystem write tool', async () => {
  let approvals = 0;
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? calls([{ id: 'write', name: 'fs_write', input: { path: 'blocked.txt', content: 'blocked' } }]) : text('denied')), {
    tool: FsWrite, permission: { mode: 'readonly' },
  });
  const off = ctx.agent.on('permission_required', () => { approvals++; });
  try {
    await deadline(ctx.agent.chat('write with readonly policy'), 'readonly write');
    expect.toEqual(approvals, 0);
    expect.toEqual((await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId))[0].state, 'DENIED');
    expect.toEqual(await fs.stat(path.join(ctx.root, 'blocked.txt')).then(() => true, () => false), false);
  } finally { off(); await ctx.close(); }
});

runner.test('real filesystem read tools cannot access a controlled file outside the sandbox', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kode-outside-'));
  const file = path.join(outside, 'sentinel.txt');
  await fs.writeFile(file, 'OUTSIDE_SENTINEL');
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? calls([{ id: 'read-outside', name: 'fs_read', input: { path: file } }]) : text('blocked')), { tool: FsRead });
  try {
    await deadline(ctx.agent.chat('read outside'), 'outside read');
    expect.toEqual((await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId))[0].state, 'FAILED');
    const history = await ctx.deps.store.loadMessages(ctx.agent.agentId);
    expect.toEqual(JSON.stringify(history).includes('OUTSIDE_SENTINEL'), false);
  } finally { await ctx.close(); await fs.rm(outside, { recursive: true, force: true }); }
});

for (const status of [401, 429, 500]) {
  runner.test(`OpenAI transport reports HTTP ${status} without returning a successful response`, async () => {
    const saved = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return new Response(JSON.stringify({ error: { message: `controlled HTTP ${status}` } }), { status }); }) as typeof fetch;
    try {
      const provider = new OpenAIProvider('offline-placeholder', 'offline', 'http://offline.invalid/v1');
      await expect.toThrow(async () => { await provider.complete([{ role: 'user', content: [{ type: 'text', text: 'test' }] }]); });
      expect.toEqual(requests, 1);
    } finally { globalThis.fetch = saved; }
  });
}

runner.test('OpenAI SSE replay preserves interleaved tool arguments for each call', async () => {
  const saved = globalThis.fetch;
  let requests = 0;
  const payload = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'one', type: 'function', function: { name: 'probe', arguments: '{"value":"A' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'two', type: 'function', function: { name: 'probe', arguments: '{"value":"B' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Ω"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '中"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  globalThis.fetch = (async () => {
    const entries = ++requests === 1 ? payload : [{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }];
    const stream = entries.map(entry => `data: ${JSON.stringify(entry)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const provider = new OpenAIProvider('offline-placeholder', 'offline', 'http://offline.invalid/v1');
  const seen: string[] = [];
  const ctx = await fixture(provider, { schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, exec: async args => { seen.push(args.value); return args.value; } });
  try {
    expect.toEqual((await deadline(ctx.agent.chat('two native tools'), 'interleaved tool arguments')).text, 'done');
    expect.toDeepEqual(seen, ['AΩ', 'B中']);
    expect.toDeepEqual((await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId)).map(record => record.state), ['COMPLETED', 'COMPLETED']);
  } finally { await ctx.close(); globalThis.fetch = saved; }
});

runner.test('OpenAI SSE replay with interleaved text and reasoning preserves the complete answer', async () => {
  const saved = globalThis.fetch;
  const entries = [
    { choices: [{ delta: { content: 'first ', reasoning_content: 'plan one' } }] },
    { choices: [{ delta: { content: 'second', reasoning_content: ' plan two' }, finish_reason: 'stop' }] },
  ];
  globalThis.fetch = (async () => new Response(entries.map(entry => `data: ${JSON.stringify(entry)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })) as typeof fetch;
  const ctx = await fixture(new OpenAIProvider('offline-placeholder', 'offline', 'http://offline.invalid/v1'));
  try {
    expect.toEqual((await deadline(ctx.agent.chat('interleaved answer'), 'text and reasoning')).text, 'first second');
    const history = await ctx.deps.store.loadMessages(ctx.agent.agentId);
    expect.toDeepEqual(history.filter(message => message.role === 'assistant')[0].content, [{ type: 'text', text: 'first second' }]);
  } finally { await ctx.close(); globalThis.fetch = saved; }
});

runner.test('OpenAI usage-only final SSE events reach the Agent token monitor', async () => {
  const saved = globalThis.fetch;
  const entries = [
    { choices: [{ delta: { content: 'counted' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 242, completion_tokens: 30 } },
  ];
  globalThis.fetch = (async () => new Response(entries.map(entry => `data: ${JSON.stringify(entry)}\n\n`).join('') + 'data: [DONE]\n\n')) as typeof fetch;
  const ctx = await fixture(new OpenAIProvider('offline-placeholder', 'offline', 'http://offline.invalid/v1'));
  const usages: any[] = [];
  ctx.agent.on('token_usage', event => usages.push([event.inputTokens, event.outputTokens, event.totalTokens]));
  try {
    expect.toEqual((await deadline(ctx.agent.chat('count tokens'), 'token usage monitor')).text, 'counted');
    expect.toDeepEqual(usages, [[242, 30, 272]]);
  } finally { await ctx.close(); globalThis.fetch = saved; }
});

runner.test('a killed worker resumes from JSONStore without replaying its tool side effect', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kode-crash-worker-'));
  const child = fork(path.resolve(__dirname, '../../helpers/crash-tool-child.cjs'), [directory], {
    execArgv: [], env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  let resumed: Agent | undefined;
  let store: JSONStore | undefined;
  try {
    await deadline(new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('message', message => (message as any).type === 'executing' ? resolve() : reject(new Error('Unexpected worker message')));
      child.once('exit', () => reject(new Error(`Worker exited before tool execution: ${stderr}`)));
    }), 'worker tool start');
    store = new JSONStore(path.join(directory, 'store'), 1);
    expect.toEqual((await store.loadToolCallRecords('crash-fixture'))[0].state, 'EXECUTING');
    child.kill('SIGKILL');
    await deadline(exited, 'own worker termination');
    store = new JSONStore(path.join(directory, 'store'), 1);
    const templates = new AgentTemplateRegistry();
    templates.register({ id: 'crash', systemPrompt: 'Controlled crash recovery', tools: ['probe'] });
    const tools = new ToolRegistry();
    let executionsAfterResume = 0;
    tools.register('probe', () => ({ name: 'probe', description: 'Must not replay', input_schema: { type: 'object' },
      toDescriptor: () => ({ source: 'registered', name: 'probe', registryId: 'probe' }),
      exec: async () => { executionsAfterResume++; return {}; },
    }));
    const model = new ScriptedProvider(() => text('recovered'));
    resumed = await Agent.resumeFromStore('crash-fixture', {
      store, templateRegistry: templates, toolRegistry: tools, sandboxFactory: new SandboxFactory(), modelFactory: () => model,
    }, { strategy: 'crash', autoRun: false });
    expect.toEqual((await deadline(resumed.chat('continue'), 'post-crash chat')).text, 'recovered');
    expect.toEqual(executionsAfterResume, 0);
    expect.toEqual(await fs.readFile(path.join(directory, 'effects.txt'), 'utf8'), 'executed\n');
    expect.toEqual((await store.loadToolCallRecords('crash-fixture'))[0].state, 'SEALED');
    const messages = await store.loadMessages('crash-fixture');
    expect.toEqual(messages.flatMap(message => message.content).filter(block => block.type === 'tool_result').length, 1);
    expect.toContain(JSON.stringify(messages), 'side effects');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await deadline(exited, 'worker cleanup');
    if (resumed) { await (resumed as any).processingPromise; await (resumed as any).sandbox.dispose(); }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (store) for await (const _entry of store.readEvents('crash-fixture')) { /* Drain recovery event writers. */ }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

for (const state of ['missing-record', 'COMPLETED', 'FAILED', 'DENIED', 'SEALED'] as const) {
  runner.test(`crash recovery reconciles persisted tool uses with ${state} before result persistence`, async () => {
    let executions = 0;
    const ctx = await fixture(new ScriptedProvider(() => text('continued')), { exec: async () => { executions++; return {}; } });
    try {
      await ctx.deps.store.saveMessages(ctx.agent.agentId, [
        { role: 'user', content: [{ type: 'text', text: 'use probe' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'crash-window', name: 'probe', input: {} }] },
      ]);
      if (state !== 'missing-record') {
        const now = Date.now();
        await ctx.deps.store.saveToolCallRecords(ctx.agent.agentId, [{ id: 'crash-window', name: 'probe', input: {}, state,
          result: state === 'COMPLETED' ? { ok: true, data: { marker: 'DURABLE_RESULT' } } : undefined,
          isError: state !== 'COMPLETED', error: state === 'COMPLETED' ? undefined : `durable ${state.toLowerCase()} error`,
          approval: { required: false }, createdAt: now, updatedAt: now, completedAt: now,
          auditTrail: [{ state, timestamp: now }],
        }]);
      }
      const resumed = await Agent.resumeFromStore(ctx.agent.agentId, ctx.deps, { strategy: 'crash', autoRun: false });
      ctx.instances.push(resumed);
      const history = await ctx.deps.store.loadMessages(ctx.agent.agentId);
      const result = history.flatMap(message => message.content).find(block => block.type === 'tool_result' && block.tool_use_id === 'crash-window');
      expect.toBeTruthy(result, 'Persisted tool use needs a matching result after recovery');
      const records = await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId);
      expect.toEqual(records[0].state, state === 'missing-record' ? 'SEALED' : state);
      if (state === 'COMPLETED') expect.toDeepEqual((result as any).content, { ok: true, data: { marker: 'DURABLE_RESULT' } });
      else expect.toEqual((result as any).is_error, true);
      if (state === 'missing-record') expect.toContain(JSON.stringify(result), 'side effects');
      await deadline(resumed.chat('continue'), 'reconciled crash snapshot');
      expect.toEqual(executions, 0);
    } finally { await ctx.close(); }
  });
}

runner.test('the execution audit is persisted before a tool can perform a side effect', async () => {
  let storedState: string | undefined;
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? calls([{ id: 'audit' }]) : text('done')), {
    exec: async () => { storedState = (await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId))[0].state; return {}; },
  });
  try {
    await deadline(ctx.agent.chat('execute audited tool'), 'execution audit');
    expect.toEqual(storedState, 'EXECUTING');
  } finally { await ctx.close(); }
});

runner.test('recovery preserves a hook-provided result without unwrapping it as a tool output', async () => {
  const ctx = await fixture(new ScriptedProvider(() => text('continued')), { exec: async () => ({}) });
  const now = Date.now();
  const result = { ok: true, data: { marker: 'HOOK_RESULT' } };
  try {
    await ctx.deps.store.saveMessages(ctx.agent.agentId, [{ role: 'assistant', content: [{ type: 'tool_use', id: 'hook-crash', name: 'probe', input: {} }] }]);
    await ctx.deps.store.saveToolCallRecords(ctx.agent.agentId, [{ id: 'hook-crash', name: 'probe', input: {}, state: 'COMPLETED', result,
      approval: { required: false }, createdAt: now, updatedAt: now,
      auditTrail: [{ state: 'COMPLETED', timestamp: now, note: 'hook provided result' }],
    }]);
    const resumed = await Agent.resumeFromStore(ctx.agent.agentId, ctx.deps, { strategy: 'crash', autoRun: false });
    ctx.instances.push(resumed);
    const restored = (await ctx.deps.store.loadMessages(ctx.agent.agentId)).flatMap(message => message.content).find(block => block.type === 'tool_result');
    expect.toDeepEqual((restored as any).content, { ok: true, data: result });
  } finally { await ctx.close(); }
});

runner.test('parallel tools serialize full audit writes before executing each call', async () => {
  const observed: string[] = [];
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? calls([
    { id: 'one', input: { id: 'one' } }, { id: 'two', input: { id: 'two' } },
  ]) : text('done')), { concurrency: 2, exec: async args => {
    const records = await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId);
    observed.push(`${args.id}:${records.find(record => record.id === args.id)!.state}`);
    return {};
  } });
  const save = ctx.deps.store.saveToolCallRecords.bind(ctx.deps.store);
  let writing = false;
  ctx.deps.store.saveToolCallRecords = async (id, records) => {
    if (writing) throw new Error('controlled overlapping full audit writes');
    writing = true;
    try { await new Promise(resolve => setImmediate(resolve)); await save(id, records); }
    finally { writing = false; }
  };
  try {
    await deadline(ctx.agent.chat('parallel audited tools'), 'serialized tool audits');
    expect.toDeepEqual(observed.sort(), ['one:EXECUTING', 'two:EXECUTING']);
    expect.toDeepEqual((await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId)).map(record => record.state), ['COMPLETED', 'COMPLETED']);
  } finally { ctx.deps.store.saveToolCallRecords = save; await ctx.close(); }
});

runner.test('recovery persists a sealed audit before writing its synthetic result', async () => {
  const ctx = await fixture(new ScriptedProvider(() => text('recovered')), { exec: async () => ({}) });
  const save = ctx.deps.store.saveMessages.bind(ctx.deps.store);
  try {
    await save(ctx.agent.agentId, [{ role: 'assistant', content: [{ type: 'tool_use', id: 'seal-write', name: 'probe', input: {} }] }]);
    ctx.deps.store.saveMessages = async (_id, messages) => {
      if (messages.some(message => message.content.some(block => block.type === 'tool_result'))) throw new Error('controlled recovery result failure');
    };
    await expect.toThrow(async () => { await Agent.resumeFromStore(ctx.agent.agentId, ctx.deps, { strategy: 'crash', autoRun: false }); }, 'controlled recovery result failure');
    expect.toEqual((await ctx.deps.store.loadToolCallRecords(ctx.agent.agentId))[0]?.state, 'SEALED');
    ctx.deps.store.saveMessages = save;
    const resumed = await Agent.resumeFromStore(ctx.agent.agentId, ctx.deps, { strategy: 'crash', autoRun: false });
    ctx.instances.push(resumed);
    expect.toEqual((await ctx.deps.store.loadMessages(ctx.agent.agentId)).flatMap(message => message.content).filter(block => block.type === 'tool_result').length, 1);
  } finally { ctx.deps.store.saveMessages = save; await ctx.close(); }
});

runner.test('an execution audit write failure prevents the tool side effect', async () => {
  let executions = 0;
  const ctx = await fixture(new ScriptedProvider(call => call === 1 ? calls([{ id: 'audit-failure' }]) : text('must not continue')), {
    exec: async () => { executions++; return {}; },
  });
  const save = ctx.deps.store.saveToolCallRecords.bind(ctx.deps.store);
  ctx.deps.store.saveToolCallRecords = async (id, records) => {
    if (records.some(record => record.state === 'EXECUTING')) throw new Error('controlled execution audit failure');
    await save(id, records);
  };
  try {
    await expect.toThrow(async () => { await deadline(ctx.agent.chat('audit failure'), 'audit failure'); }, 'controlled execution audit failure');
    expect.toEqual(executions, 0);
  } finally { ctx.deps.store.saveToolCallRecords = save; await ctx.close(); }
});

runner.test('an HTTP 200 SSE provider error rejects instead of completing an empty answer', async () => {
  const saved = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"error":{"message":"controlled upstream failure"}}\n\ndata: [DONE]\n\n')); },
    cancel() { cancelled = true; },
  }))) as typeof fetch;
  const ctx = await fixture(new OpenAIProvider('offline-placeholder', 'offline', 'http://offline.invalid/v1'));
  try {
    await expect.toThrow(async () => { await deadline(ctx.agent.chat('upstream failure'), 'SSE error'); }, 'controlled upstream failure');
    expect.toEqual(cancelled, true);
  } finally { await ctx.close(); globalThis.fetch = saved; }
});

export async function run() { return runner.run(); }
