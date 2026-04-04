import fs from 'node:fs';
import path from 'node:path';
import {
  Agent,
  AgentTemplateRegistry,
  JSONStore,
  MemoryObservationStore,
  SandboxFactory,
  ToolRegistry,
} from '../../../src';
import { ModelConfig, ModelProvider, ModelResponse, ModelStreamChunk } from '../../../src/infra/provider';
import { TestRunner, expect } from '../../helpers/utils';
import { TEST_ROOT } from '../../helpers/fixtures';
import { ensureCleanDir, wait } from '../../helpers/setup';

const runner = new TestRunner('Observability Memory Store');

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

function createTextStream(text: string): () => AsyncIterable<ModelStreamChunk> {
  return async function* () {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 } };
    yield { type: 'message_stop' };
  };
}

async function createObservedAgent(params: {
  id: string;
  provider: ModelProvider;
  store: MemoryObservationStore;
}) {
  const workDir = path.join(TEST_ROOT, `obs-memory-work-${params.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const storeDir = path.join(TEST_ROOT, `obs-memory-store-${params.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  ensureCleanDir(workDir);
  ensureCleanDir(storeDir);

  const templates = new AgentTemplateRegistry();
  templates.register({
    id: params.id,
    systemPrompt: 'memory store test',
    tools: [],
    permission: { mode: 'auto' },
  });

  const agent = await Agent.create(
    {
      templateId: params.id,
      model: params.provider,
      sandbox: { kind: 'local', workDir, enforceBoundary: true },
      observability: { sink: params.store },
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

runner
  .test('MemoryObservationStore 支持跨 agent 聚合与过滤', async () => {
    const store = new MemoryObservationStore();
    const first = await createObservedAgent({
      id: 'obs-memory-agent-a',
      provider: new QueueStreamProvider([createTextStream('agent a')]),
      store,
    });
    const second = await createObservedAgent({
      id: 'obs-memory-agent-b',
      provider: new QueueStreamProvider([createTextStream('agent b')]),
      store,
    });

    try {
      await first.agent.chat('hello a');
      await second.agent.chat('hello b');

      for (let i = 0; i < 20; i++) {
        if (store.listObservations().length >= 4) {
          break;
        }
        await wait(10);
      }

      const all = store.listObservations();
      expect.toHaveLength(all, 4);
      expect.toEqual(all[0].seq, 0);
      expect.toEqual(all[3].seq, 3);

      const agentA = store.listObservations({ agentId: first.agent.agentId });
      expect.toHaveLength(agentA, 2);

      const runId = agentA[1].observation.runId;
      const byRun = store.listObservations({ runId });
      expect.toHaveLength(byRun, 2);

      const traceId = byRun[0].observation.traceId;
      const byTrace = store.listObservations({ traceId });
      expect.toHaveLength(byTrace, 2);

      const runView = store.getRun(runId);
      expect.toBeTruthy(runView);
      expect.toEqual(runView?.run.observation.kind, 'agent_run');
      expect.toHaveLength(runView?.observations || [], 2);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  })
  .test('MemoryObservationStore.subscribe 支持 store 级 sinceSeq 补读', async () => {
    const store = new MemoryObservationStore();
    const agent = await createObservedAgent({
      id: 'obs-memory-replay',
      provider: new QueueStreamProvider([createTextStream('memory replay')]),
      store,
    });

    try {
      await agent.agent.chat('hello');

      for (let i = 0; i < 20; i++) {
        if (store.listObservations().length >= 2) {
          break;
        }
        await wait(10);
      }

      const existing = store.listObservations();
      expect.toHaveLength(existing, 2);

      const replayed: any[] = [];
      for await (const envelope of store.subscribe({ sinceSeq: existing[0].seq })) {
        replayed.push(envelope);
        break;
      }

      expect.toHaveLength(replayed, 1);
      expect.toEqual(replayed[0].seq, existing[1].seq);
      expect.toEqual(replayed[0].observation.kind, 'agent_run');
    } finally {
      await agent.cleanup();
    }
  })
  .test('MemoryObservationStore 超过上限时淘汰最旧数据', async () => {
    const store = new MemoryObservationStore({ maxEntries: 2 });
    const baseObservation = {
      kind: 'generation' as const,
      agentId: 'agent-x',
      runId: 'run-x',
      traceId: 'trace-x',
      spanId: 'span-x',
      name: 'generation:test',
      status: 'ok' as const,
      startTime: 1,
      endTime: 2,
      durationMs: 1,
    };

    store.onObservation({ seq: 0, timestamp: 1, observation: { ...baseObservation, spanId: 'span-1' } });
    store.onObservation({ seq: 0, timestamp: 2, observation: { ...baseObservation, spanId: 'span-2' } });
    store.onObservation({ seq: 0, timestamp: 3, observation: { ...baseObservation, spanId: 'span-3' } });

    const all = store.listObservations();
    expect.toHaveLength(all, 2);
    expect.toEqual(all[0].observation.spanId, 'span-2');
    expect.toEqual(all[1].observation.spanId, 'span-3');
  });

export async function run() {
  return runner.run();
}
