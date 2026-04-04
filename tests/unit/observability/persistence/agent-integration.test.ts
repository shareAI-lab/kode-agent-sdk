import fs from 'node:fs';
import path from 'node:path';

import {
  Agent,
  AgentTemplateRegistry,
  JSONStore,
  JSONStoreObservationBackend,
  MemoryObservationStore,
  SandboxFactory,
  ToolRegistry,
  createStoreBackedObservationReader,
  type ModelConfig,
  type ModelProvider,
  type ModelResponse,
  type ModelStreamChunk,
  type OTelSpanData,
  type OTelSpanExporter,
} from '../../../../src';
import { TEST_ROOT } from '../../../helpers/fixtures';
import { ensureCleanDir, wait } from '../../../helpers/setup';
import { TestRunner, expect } from '../../../helpers/utils';

const runner = new TestRunner('Observability Persistence Agent Integration');

class QueueStreamProvider implements ModelProvider {
  readonly model = 'queue-stream-provider';
  readonly maxWindowSize = 128000;
  readonly maxOutputTokens = 4096;
  readonly temperature = 0;

  constructor(private readonly streams: Array<() => AsyncIterable<ModelStreamChunk>>) {}

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
      provider: 'mock',
      model: this.model,
    };
  }
}

class RecordingExporter implements OTelSpanExporter {
  readonly batches: OTelSpanData[][] = [];

  async export(spans: OTelSpanData[]): Promise<void> {
    this.batches.push(spans);
  }
}

async function createObservedAgent(params: {
  storeDir: string;
  workDir: string;
  backend: JSONStoreObservationBackend;
  provider: ModelProvider;
  memoryStore?: MemoryObservationStore;
  exporter?: RecordingExporter;
}) {
  const templates = new AgentTemplateRegistry();
  templates.register({
    id: 'obs-persist-agent',
    systemPrompt: 'persistence integration test',
    tools: [],
    permission: { mode: 'auto' },
  });

  return Agent.create(
    {
      templateId: 'obs-persist-agent',
      model: params.provider,
      sandbox: { kind: 'local', workDir: params.workDir, enforceBoundary: true },
      observability: {
        sink: params.memoryStore,
        otel: params.exporter ? { exporter: params.exporter, attributeNamespace: 'dual' } : undefined,
        persistence: {
          backend: params.backend,
          enabled: true,
        },
      },
    },
    {
      store: new JSONStore(params.storeDir),
      templateRegistry: templates,
      sandboxFactory: new SandboxFactory(),
      toolRegistry: new ToolRegistry(),
    }
  );
}

runner
  .test('persisted observation backend survives agent restart-style recreation', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const workDir = path.join(TEST_ROOT, `obs-persist-work-${suffix}`);
    const storeDir = path.join(TEST_ROOT, `obs-persist-store-${suffix}`);
    ensureCleanDir(workDir);
    ensureCleanDir(storeDir);

    try {
      const backend = new JSONStoreObservationBackend(storeDir);
      const agent = await createObservedAgent({
        storeDir,
        workDir,
        backend,
        provider: new QueueStreamProvider([
          async function* () {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'persist me' } };
            yield { type: 'content_block_stop', index: 0 };
            yield { type: 'message_delta', usage: { input_tokens: 2, output_tokens: 3 } };
            yield { type: 'message_stop' };
          },
        ]),
      });

      const result = await agent.chat('hello');
      expect.toEqual(result.status, 'ok');
      await wait(20);
      await (agent as any).sandbox?.dispose?.();

      const reader = createStoreBackedObservationReader(new JSONStoreObservationBackend(storeDir));
      const observations = await reader.listObservations();
      expect.toHaveLength(observations, 2);
      expect.toEqual(observations[0].observation.kind, 'generation');
      expect.toEqual(observations[1].observation.kind, 'agent_run');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  })
  .test('persistence can coexist with native sink and otel sink', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const workDir = path.join(TEST_ROOT, `obs-persist-work-${suffix}`);
    const storeDir = path.join(TEST_ROOT, `obs-persist-store-${suffix}`);
    ensureCleanDir(workDir);
    ensureCleanDir(storeDir);

    try {
      const memoryStore = new MemoryObservationStore();
      const exporter = new RecordingExporter();
      const backend = new JSONStoreObservationBackend(storeDir);
      const agent = await createObservedAgent({
        storeDir,
        workDir,
        backend,
        memoryStore,
        exporter,
        provider: new QueueStreamProvider([
          async function* () {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fanout ok' } };
            yield { type: 'content_block_stop', index: 0 };
            yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 } };
            yield { type: 'message_stop' };
          },
        ]),
      });

      await agent.chat('hello');

      let persisted: any[] = [];
      for (let i = 0; i < 20; i++) {
        persisted = await createStoreBackedObservationReader(backend).listObservations();
        if (
          memoryStore.listObservations().length >= 2 &&
          exporter.batches.flat().length >= 2 &&
          persisted.length >= 2
        ) {
          break;
        }
        await wait(10);
      }

      expect.toHaveLength(memoryStore.listObservations(), 2);
      expect.toHaveLength(exporter.batches.flat(), 2);
      expect.toHaveLength(persisted, 2);

      await (agent as any).sandbox?.dispose?.();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

export async function run() {
  return runner.run();
}
