import fs from 'node:fs';
import path from 'node:path';
import {
  Agent,
  AgentTemplateRegistry,
  JSONStore,
  SandboxFactory,
  ToolRegistry,
} from '../../../src';
import { ModelConfig, ModelProvider, ModelResponse, ModelStreamChunk } from '../../../src/infra/provider';
import { TestRunner, expect } from '../../helpers/utils';
import { TEST_ROOT } from '../../helpers/fixtures';
import { ensureCleanDir, wait } from '../../helpers/setup';

const runner = new TestRunner('Observability Scheduler Metadata');

class QueueStreamProvider implements ModelProvider {
  readonly model = 'queue-stream-provider';
  readonly maxWindowSize = 128000;
  readonly maxOutputTokens = 4096;
  readonly temperature = 0;

  constructor(
    private readonly streams: Array<() => AsyncIterable<ModelStreamChunk>>,
    private readonly providerName = 'mock'
  ) {}

  async complete(): Promise<ModelResponse> {
    throw new Error('complete() should not be called');
  }

  async *stream(): AsyncIterable<ModelStreamChunk> {
    const next = this.streams.shift();
    if (!next) {
      throw new Error('No scripted stream available');
    }
    yield* next();
  }

  toConfig(): ModelConfig {
    return {
      provider: this.providerName,
      model: this.model,
    };
  }
}

async function createObservedAgent(provider: ModelProvider) {
  const workDir = path.join(TEST_ROOT, `obs-scheduler-work-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const storeDir = path.join(TEST_ROOT, `obs-scheduler-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  ensureCleanDir(workDir);
  ensureCleanDir(storeDir);

  const templates = new AgentTemplateRegistry();
  templates.register({
    id: 'obs-scheduler-agent',
    systemPrompt: 'test scheduler observability',
    tools: [],
    permission: { mode: 'auto' },
  });

  const agent = await Agent.create(
    {
      templateId: 'obs-scheduler-agent',
      model: provider,
      sandbox: { kind: 'local', workDir, enforceBoundary: true },
    },
    {
      store: new JSONStore(storeDir),
      templateRegistry: templates,
      sandboxFactory: new SandboxFactory(),
      toolRegistry: new ToolRegistry(),
    }
  );

  return {
    agent,
    cleanup: async () => {
      await (agent as any).sandbox?.dispose?.();
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

function createTextStream(text: string): () => AsyncIterable<ModelStreamChunk> {
  return async function* () {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 } };
    yield { type: 'message_stop' };
  };
}

async function waitForAgentRuns(agent: Agent, count: number) {
  for (let i = 0; i < 50; i++) {
    const runs = (agent as any).observationCollector.list({ kinds: ['agent_run'] });
    if (runs.length >= count) {
      return runs;
    }
    await wait(20);
  }
  return (agent as any).observationCollector.list({ kinds: ['agent_run'] });
}

runner
  .test('scheduler 触发的后续 run 会带 agent_run metadata.scheduler', async () => {
    const provider = new QueueStreamProvider([
      createTextStream('user run'),
      createTextStream('scheduler run'),
    ]);
    const { agent, cleanup } = await createObservedAgent(provider);

    const schedulerEvents: any[] = [];
    const offScheduler = agent.on('scheduler_triggered', (evt: any) => {
      schedulerEvents.push(evt);
    });

    const scheduler = agent.schedule();
    scheduler.everySteps(1, async () => {
      scheduler.clear();
      await agent.send('scheduled follow-up');
    });

    try {
      const result = await agent.chat('initial');
      expect.toEqual(result.status, 'ok');

      const runs = await waitForAgentRuns(agent, 2);
      expect.toHaveLength(runs, 2);

      expect.toEqual(runs[0].trigger, 'send');
      expect.toEqual((runs[0].metadata || {}).scheduler, undefined);

      expect.toEqual(runs[1].trigger, 'scheduler');
      expect.toBeTruthy(runs[1].metadata?.scheduler);
      expect.toContain(runs[1].metadata?.scheduler?.taskId || '', 'steps-');
      expect.toEqual(runs[1].metadata?.scheduler?.kind, 'steps');
      expect.toEqual(runs[1].metadata?.scheduler?.spec, 'steps:1');

      const snapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.scheduledRuns, 1);

      expect.toHaveLength(schedulerEvents, 1);
      expect.toEqual(schedulerEvents[0].kind, 'steps');
      expect.toEqual(schedulerEvents[0].spec, 'steps:1');
    } finally {
      offScheduler();
      scheduler.clear();
      await cleanup();
    }
  })
  .test('普通 run 不应带 scheduler metadata', async () => {
    const provider = new QueueStreamProvider([createTextStream('plain run')]);
    const { agent, cleanup } = await createObservedAgent(provider);

    try {
      const result = await agent.chat('hello');
      expect.toEqual(result.status, 'ok');

      const runs = await waitForAgentRuns(agent, 1);
      expect.toHaveLength(runs, 1);
      expect.toEqual(runs[0].trigger, 'send');
      expect.toEqual((runs[0].metadata || {}).scheduler, undefined);

      const snapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.scheduledRuns, 0);
    } finally {
      await cleanup();
    }
  })
  .test('scheduler reminder 不应污染下一次用户 run 的 trigger', async () => {
    const provider = new QueueStreamProvider([
      createTextStream('first run'),
      createTextStream('second run'),
    ]);
    const { agent, cleanup } = await createObservedAgent(provider);

    const scheduler = agent.schedule();
    scheduler.everySteps(1, async () => {
      scheduler.clear();
      await agent.send('scheduled reminder', { kind: 'reminder' });
    });

    try {
      const first = await agent.chat('initial');
      expect.toEqual(first.status, 'ok');

      await wait(50);

      const second = await agent.chat('after reminder');
      expect.toEqual(second.status, 'ok');

      const runs = await waitForAgentRuns(agent, 2);
      expect.toHaveLength(runs, 2);
      expect.toEqual(runs[0].trigger, 'send');
      expect.toEqual(runs[1].trigger, 'send');
      expect.toEqual((runs[1].metadata || {}).scheduler, undefined);

      const snapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.scheduledRuns, 0);
    } finally {
      scheduler.clear();
      await cleanup();
    }
  });

export async function run() {
  return runner.run();
}
