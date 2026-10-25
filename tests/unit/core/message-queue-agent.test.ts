import { Agent } from '../../../src';
import { createUnitTestAgent, collectEvents } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('Agent message persistence');

async function deadline<T>(task: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish`)), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

async function finish(agent: Agent) {
  await (agent as any).processingPromise;
}

runner.test('concurrent send during persistence is processed in a later turn', async () => {
  const ctx = await createUnitTestAgent({ mockResponses: ['reply'] });
  const save = ctx.deps.store.saveMessages.bind(ctx.deps.store);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writing = new Promise<void>((resolve) => { started = resolve; });
  let firstWrite = true;
  ctx.deps.store.saveMessages = async (id, messages) => {
    if (firstWrite) {
      firstWrite = false;
      started();
      await gate;
    }
    await save(id, messages);
  };
  let completed = 0;
  const done = collectEvents(ctx.agent, ['progress'], (event) => event.type === 'done' && ++completed === 2);
  try {
    await ctx.agent.send('first');
    await deadline(writing, 'first persistence');
    await ctx.agent.send('second');
    release();
    await deadline(done, 'both turns');
    await finish(ctx.agent);
    const history = await ctx.deps.store.loadMessages(ctx.agent.agentId);
    const users = history.filter(message => message.role === 'user').flatMap(message => message.content)
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text);
    expect.toDeepEqual(users, ['first', 'second']);
  } finally {
    release();
    ctx.deps.store.saveMessages = save;
    await finish(ctx.agent);
    await (ctx.agent as any).sandbox.dispose();
    await ctx.cleanup();
  }
});

runner.test('retry after a failed persistence keeps one copy of each message across resume', async () => {
  const ctx = await createUnitTestAgent({ mockResponses: ['reply'] });
  const save = ctx.deps.store.saveMessages.bind(ctx.deps.store);
  const errors: string[] = [];
  const off = ctx.agent.on('error', event => errors.push(event.message));
  let fail = true;
  ctx.deps.store.saveMessages = async (id, messages) => {
    if (fail) { fail = false; throw new Error('temporary persistence failure'); }
    await save(id, messages);
  };
  let resumed: Agent | undefined;
  try {
    await deadline(ctx.agent.chat('first').catch(() => undefined), 'failed turn');
    await finish(ctx.agent);
    expect.toBeTruthy(errors.some(message => message.includes('temporary persistence failure')));
    await deadline(ctx.agent.chat('second'), 'retried turn');
    await finish(ctx.agent);
    ctx.deps.store.saveMessages = save;
    resumed = await Agent.resumeFromStore(ctx.agent.agentId, ctx.deps, { autoRun: false, strategy: 'crash' });
    await deadline(resumed.chat('after restart'), 'resumed turn');
    await finish(resumed);
    const history = await ctx.deps.store.loadMessages(ctx.agent.agentId);
    const text = history.filter(message => message.role === 'user').flatMap(message => message.content)
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text);
    expect.toEqual(text.filter(value => value === 'first').length, 1);
    expect.toEqual(text.filter(value => value === 'second').length, 1);
    expect.toEqual(text.filter(value => value === 'after restart').length, 1);
  } finally {
    off();
    ctx.deps.store.saveMessages = save;
    if (resumed) {
      await finish(resumed);
      await (resumed as any).sandbox.dispose();
    }
    await finish(ctx.agent);
    await (ctx.agent as any).sandbox.dispose();
    await ctx.cleanup();
  }
});

export async function run() { return runner.run(); }
