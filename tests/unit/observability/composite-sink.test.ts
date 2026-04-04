import fs from 'node:fs';
import path from 'node:path';
import {
  Agent,
  AgentTemplateRegistry,
  CompositeObservationSink,
  JSONStore,
  MemoryObservationStore,
  SandboxFactory,
  ToolRegistry,
} from '../../../src';
import { ModelConfig, ModelProvider, ModelResponse, ModelStreamChunk } from '../../../src/infra/provider';
import { TestRunner, expect } from '../../helpers/utils';
import { TEST_ROOT } from '../../helpers/fixtures';
import { ensureCleanDir, wait } from '../../helpers/setup';

const runner = new TestRunner('Observability Composite Sink');

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

async function createObservedAgent(params: {
  provider: ModelProvider;
  sink: CompositeObservationSink;
}) {
  const workDir = path.join(TEST_ROOT, `obs-composite-work-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const storeDir = path.join(TEST_ROOT, `obs-composite-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  ensureCleanDir(workDir);
  ensureCleanDir(storeDir);

  const templates = new AgentTemplateRegistry();
  templates.register({
    id: 'obs-composite-agent',
    systemPrompt: 'composite sink test',
    tools: [],
    permission: { mode: 'auto' },
  });

  const agent = await Agent.create(
    {
      templateId: 'obs-composite-agent',
      model: params.provider,
      sandbox: { kind: 'local', workDir, enforceBoundary: true },
      observability: { sink: params.sink },
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

runner.test('CompositeObservationSink 中单个 sink 失败不影响其他 sink 与主流程', async () => {
  const received: any[] = [];
  const memoryStore = new MemoryObservationStore();
  const composite = new CompositeObservationSink([
    {
      onObservation(envelope) {
        received.push(envelope);
        throw new Error('sink boom');
      },
    },
    memoryStore,
  ]);

  const provider = new QueueStreamProvider([
    async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'composite ok' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', usage: { input_tokens: 2, output_tokens: 3 } };
      yield { type: 'message_stop' };
    },
  ]);

  const { agent, cleanup } = await createObservedAgent({ provider, sink: composite });

  try {
    const result = await agent.chat('hello');
    expect.toEqual(result.status, 'ok');
    expect.toContain(result.text || '', 'composite ok');

    for (let i = 0; i < 20; i++) {
      if (received.length >= 2 && memoryStore.listObservations().length >= 2) {
        break;
      }
      await wait(10);
    }

    expect.toBeGreaterThanOrEqual(received.length, 2);

    const storeObservations = memoryStore.listObservations();
    expect.toHaveLength(storeObservations, 2);
    expect.toEqual(storeObservations[0].observation.kind, 'generation');
    expect.toEqual(storeObservations[1].observation.kind, 'agent_run');

    const snapshot = agent.getMetricsSnapshot();
    expect.toEqual(snapshot.totals.totalTokens, 5);
    expect.toEqual(snapshot.totals.generations, 1);

    const readerObservations = agent.getObservationReader().listObservations();
    expect.toHaveLength(readerObservations, 2);
  } finally {
    await cleanup();
  }
});

export async function run() {
  return runner.run();
}
