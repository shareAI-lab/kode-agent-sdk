import fs from 'node:fs';
import path from 'node:path';
import {
  Agent,
  AgentTemplateRegistry,
  JSONStore,
  MemoryObservationStore,
  OTelObservationSink,
  SandboxFactory,
  ToolRegistry,
  type ModelConfig,
  type ModelProvider,
  type ModelResponse,
  type ModelStreamChunk,
  type ObservationEnvelope,
  type OTelSpanData,
  type OTelSpanExporter,
} from '../../../../src';
import { TEST_ROOT } from '../../../helpers/fixtures';
import { ensureCleanDir, wait } from '../../../helpers/setup';
import { TestRunner, expect } from '../../../helpers/utils';

const runner = new TestRunner('Observability OTel Sink');

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

class RecordingExporter implements OTelSpanExporter {
  readonly batches: OTelSpanData[][] = [];
  shutdownCalls = 0;

  async export(spans: OTelSpanData[]): Promise<void> {
    this.batches.push(spans);
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

function createGenerationEnvelope(seq: number): ObservationEnvelope {
  return {
    seq,
    timestamp: 1710000000000 + seq,
    observation: {
      kind: 'generation',
      agentId: 'agent-1',
      runId: 'run-1',
      traceId: 'trace-1',
      spanId: 'span-' + seq,
      parentSpanId: 'parent-1',
      name: 'generation:gpt-4.1',
      status: 'ok',
      startTime: 1710000000000 + seq,
      endTime: 1710000000050 + seq,
      durationMs: 50,
      provider: 'openai',
      model: 'gpt-4.1',
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
      },
      request: {
        latencyMs: 50,
      },
    },
  };
}

async function createObservedAgent(params: {
  provider: ModelProvider;
  memoryStore: MemoryObservationStore;
  exporter: OTelSpanExporter;
}) {
  const suffix = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const workDir = path.join(TEST_ROOT, 'obs-otel-work-' + suffix);
  const storeDir = path.join(TEST_ROOT, 'obs-otel-store-' + suffix);
  ensureCleanDir(workDir);
  ensureCleanDir(storeDir);

  const templates = new AgentTemplateRegistry();
  templates.register({
    id: 'obs-otel-agent',
    systemPrompt: 'otel sink test',
    tools: [],
    permission: { mode: 'auto' },
  });

  const agent = await Agent.create(
    {
      templateId: 'obs-otel-agent',
      model: params.provider,
      sandbox: { kind: 'local', workDir, enforceBoundary: true },
      observability: {
        sink: params.memoryStore,
        otel: {
          exporter: params.exporter,
          attributeNamespace: 'dual',
        },
      },
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
  .test('OTelObservationSink supports batched flush', async () => {
    const exporter = new RecordingExporter();
    const sink = new OTelObservationSink({
      exporter,
      exportMode: 'batched',
      batchSize: 2,
      flushIntervalMs: 1000,
    });

    await sink.onObservation(createGenerationEnvelope(1));
    expect.toHaveLength(exporter.batches, 0);

    await sink.onObservation(createGenerationEnvelope(2));
    expect.toHaveLength(exporter.batches, 1);
    expect.toHaveLength(exporter.batches[0], 2);

    await sink.onObservation(createGenerationEnvelope(3));
    expect.toHaveLength(exporter.batches, 1);

    await sink.forceFlush();
    expect.toHaveLength(exporter.batches, 2);
    expect.toHaveLength(exporter.batches[1], 1);

    await sink.shutdown();
    expect.toEqual(exporter.shutdownCalls, 1);
  })
  .test('Agent observability can fan out to native sink and OTel bridge sink', async () => {
    const memoryStore = new MemoryObservationStore();
    const exporter = new RecordingExporter();
    const provider = new QueueStreamProvider([
      async function* () {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'otel bridge ok' } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', usage: { input_tokens: 2, output_tokens: 3 } };
        yield { type: 'message_stop' };
      },
    ]);

    const { agent, cleanup } = await createObservedAgent({
      provider,
      memoryStore,
      exporter,
    });

    try {
      const result = await agent.chat('hello');
      expect.toEqual(result.status, 'ok');

      for (let i = 0; i < 20; i++) {
        if (memoryStore.listObservations().length >= 2 && exporter.batches.length >= 2) {
          break;
        }
        await wait(10);
      }

      const observations = memoryStore.listObservations();
      expect.toHaveLength(observations, 2);
      expect.toEqual(observations[0].observation.kind, 'generation');
      expect.toEqual(observations[1].observation.kind, 'agent_run');

      const exportedSpans = exporter.batches.flat();
      expect.toHaveLength(exportedSpans, 2);
      expect.toEqual(exportedSpans[0].name, 'llm.generation');
      expect.toEqual(exportedSpans[1].name, 'agent.run');
      expect.toEqual(exportedSpans[0].attributes['gen_ai.system'], 'mock');
    } finally {
      await cleanup();
    }
  });

export async function run() {
  return runner.run();
}
