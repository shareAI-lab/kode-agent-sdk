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
import { ensureCleanDir } from '../../helpers/setup';

const runner = new TestRunner('Observability Compression');

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
  context?: { maxTokens?: number; compressToTokens?: number };
}) {
  const workDir = path.join(TEST_ROOT, `obs-compress-work-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const storeDir = path.join(TEST_ROOT, `obs-compress-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  ensureCleanDir(workDir);
  ensureCleanDir(storeDir);

  const templates = new AgentTemplateRegistry();
  templates.register({
    id: 'obs-compress-agent',
    systemPrompt: 'test compression observability',
    tools: [],
    permission: { mode: 'auto' },
  });

  const agent = await Agent.create(
    {
      templateId: 'obs-compress-agent',
      model: params.provider,
      sandbox: { kind: 'local', workDir, enforceBoundary: true },
      context: params.context,
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

async function listCompressionObservations(agent: Agent) {
  return (agent as any).observationCollector.list({ kinds: ['compression'] });
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

runner
  .test('触发 context compression 时生成 compression observation 与快照聚合', async () => {
    const provider = new QueueStreamProvider([
      createTextStream('first'),
      createTextStream('second'),
    ]);
    const { agent, cleanup } = await createObservedAgent({
      provider,
      context: { maxTokens: 50, compressToTokens: 10 },
    });

    try {
      await agent.chat('a'.repeat(120));
      await agent.chat('b'.repeat(120));

      const observations = await listCompressionObservations(agent);
      expect.toHaveLength(observations, 1);
      expect.toEqual(observations[0].kind, 'compression');
      expect.toEqual(observations[0].status, 'ok');
      expect.toEqual(observations[0].summaryGenerated, true);
      expect.toBeTruthy(observations[0].messageCountBefore >= 1);
      expect.toBeTruthy(observations[0].messageCountAfter !== undefined);
      expect.toBeTruthy(observations[0].estimatedTokensBefore !== undefined);
      expect.toBeTruthy(observations[0].estimatedTokensAfter !== undefined);

      const snapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.compressions, 1);
      expect.toEqual(snapshot.totals.compressionErrors, 0);
      expect.toBeGreaterThanOrEqual(snapshot.totals.tokensSavedEstimate, 0);
    } finally {
      await cleanup();
    }
  })
  .test('未触发压缩时不生成 compression observation', async () => {
    const provider = new QueueStreamProvider([createTextStream('no compression')]);
    const { agent, cleanup } = await createObservedAgent({
      provider,
      context: { maxTokens: 1000, compressToTokens: 500 },
    });

    try {
      await agent.chat('short prompt');

      const snapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.compressions, 0);
      expect.toEqual(snapshot.totals.compressionErrors, 0);

      const observations = await listCompressionObservations(agent);
      expect.toHaveLength(observations, 0);
    } finally {
      await cleanup();
    }
  })
  .test('压缩失败时记录 compression error observation', async () => {
    const provider = new QueueStreamProvider([createTextStream('unused because compression fails')]);
    const { agent, cleanup } = await createObservedAgent({
      provider,
      context: { maxTokens: 50, compressToTokens: 10 },
    });

    (agent as any).contextManager.compress = async () => {
      throw new Error('compression boom');
    };

    try {
      const result = await agent.chat('z'.repeat(240));
      expect.toEqual(result.status, 'ok');

      const observations = await listCompressionObservations(agent);
      expect.toHaveLength(observations, 1);
      expect.toEqual(observations[0].kind, 'compression');
      expect.toEqual(observations[0].status, 'error');
      expect.toEqual(observations[0].summaryGenerated, false);
      expect.toContain(observations[0].errorMessage || '', 'compression boom');

      const snapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.compressions, 1);
      expect.toEqual(snapshot.totals.compressionErrors, 1);
      expect.toEqual(snapshot.totals.tokensSavedEstimate, 0);
    } finally {
      await cleanup();
    }
  });

export async function run() {
  return runner.run();
}
