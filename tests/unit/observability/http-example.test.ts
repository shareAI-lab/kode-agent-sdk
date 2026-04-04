import fs from 'node:fs';
import path from 'node:path';

import {
  Agent,
  AgentTemplateRegistry,
  JSONStore,
  JSONStoreObservationBackend,
  SandboxFactory,
  ToolRegistry,
  createStoreBackedObservationReader,
  type ModelConfig,
  type ModelProvider,
  type ModelResponse,
  type ModelStreamChunk,
} from '../../../src';
import { createExampleObservabilityHttpHandler } from '../../../examples/shared/observability-http';
import { TEST_ROOT } from '../../helpers/fixtures';
import { ensureCleanDir, wait } from '../../helpers/setup';
import { TestRunner, expect, retry } from '../../helpers/utils';

const runner = new TestRunner('Observability HTTP Example Skeleton');

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

async function createObservedAgent(suffix: string) {
  const workDir = path.join(TEST_ROOT, `obs-http-example-work-${suffix}`);
  const storeDir = path.join(TEST_ROOT, `obs-http-example-store-${suffix}`);
  ensureCleanDir(workDir);
  ensureCleanDir(storeDir);

  const templates = new AgentTemplateRegistry();
  templates.register({
    id: 'obs-http-example-agent',
    systemPrompt: 'observability http example test',
    tools: [],
    permission: { mode: 'auto' },
  });

  const observationBackend = new JSONStoreObservationBackend(storeDir);
  const agent = await Agent.create(
    {
      agentId: `agt-obs-http-example-${suffix}`,
      templateId: 'obs-http-example-agent',
      model: new QueueStreamProvider([
        async function* () {
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'observability-example-ok' } };
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 7 } };
          yield { type: 'message_stop' };
        },
      ]),
      sandbox: { kind: 'local', workDir, enforceBoundary: true },
      observability: {
        persistence: {
          enabled: true,
          backend: observationBackend,
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
    observationBackend,
    cleanup: async () => {
      await (agent as any).sandbox?.dispose?.();
      await wait(10);
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

runner
  .test('handler exposes runtime metrics and runtime observations from the live agent instance', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const { agent, observationBackend, cleanup } = await createObservedAgent(suffix);

    try {
      const result = await agent.chat('hello observability');
      expect.toEqual(result.status, 'ok');

      const persistedReader = createStoreBackedObservationReader(observationBackend);
      const handler = createExampleObservabilityHttpHandler({
        basePath: '/api/observability',
        resolveRuntimeSource: async (agentId) =>
          agentId === agent.agentId
            ? {
                getMetricsSnapshot: () => agent.getMetricsSnapshot(),
                getObservationReader: () => agent.getObservationReader(),
              }
            : undefined,
        resolvePersistedReader: async (agentId) => (agentId === agent.agentId ? persistedReader : undefined),
      });

      const metricsResponse = await handler({
        method: 'GET',
        url: `/api/observability/agents/${agent.agentId}/metrics`,
      });
      expect.toEqual(metricsResponse.status, 200);
      const metricsBody = metricsResponse.body as any;
      expect.toEqual(metricsBody.agentId, agent.agentId);
      expect.toEqual(metricsBody.totals.generations, 1);
      expect.toBeGreaterThan(metricsBody.totals.totalTokens, 0);

      const runtimeResponse = await retry(async () => {
        const response = await handler({
          method: 'GET',
          url: `/api/observability/agents/${agent.agentId}/observations/runtime?limit=20`,
        });
        const body = response.body as any;
        const kinds = Array.isArray(body?.observations)
          ? body.observations.map((entry: any) => entry.observation.kind)
          : [];
        if (response.status !== 200 || !kinds.includes('generation') || !kinds.includes('agent_run')) {
          throw new Error('runtime observations not ready');
        }
        return response;
      }, 10, 20);
      expect.toEqual(runtimeResponse.status, 200);
      const runtimeBody = runtimeResponse.body as any;
      const runtimeKinds = runtimeBody.observations.map((entry: any) => entry.observation.kind);
      expect.toContain(runtimeKinds, 'generation');
      expect.toContain(runtimeKinds, 'agent_run');

      const generationEnvelope = runtimeBody.observations.find((entry: any) => entry.observation.kind === 'generation');
      expect.toBeTruthy(generationEnvelope);

      const runtimeRunResponse = await handler({
        method: 'GET',
        url: `/api/observability/agents/${agent.agentId}/observations/runtime/runs/${generationEnvelope.observation.runId}`,
      });
      expect.toEqual(runtimeRunResponse.status, 200);
      const runtimeRunBody = runtimeRunResponse.body as any;
      expect.toEqual(runtimeRunBody.run.observation.kind, 'agent_run');
      expect.toContain(
        runtimeRunBody.observations.map((entry: any) => entry.observation.kind),
        'generation'
      );
    } finally {
      await cleanup();
    }
  })
  .test('handler exposes persisted observations and rejects invalid app-layer requests', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const { agent, observationBackend, cleanup } = await createObservedAgent(suffix);

    try {
      await agent.chat('hello persisted');

      const persistedReader = createStoreBackedObservationReader(observationBackend);
      const handler = createExampleObservabilityHttpHandler({
        basePath: '/api/observability',
        resolveRuntimeSource: async (agentId) =>
          agentId === agent.agentId
            ? {
                getMetricsSnapshot: () => agent.getMetricsSnapshot(),
                getObservationReader: () => agent.getObservationReader(),
              }
            : undefined,
        resolvePersistedReader: async (agentId) => (agentId === agent.agentId ? persistedReader : undefined),
      });

      const persistedResponse = await retry(async () => {
        const response = await handler({
          method: 'GET',
          url: `/api/observability/agents/${agent.agentId}/observations/persisted?limit=20`,
        });
        const body = response.body as any;
        if (response.status !== 200 || !Array.isArray(body.observations) || body.observations.length < 2) {
          throw new Error('persisted observations not ready');
        }
        return response;
      }, 10, 20);

      expect.toEqual(persistedResponse.status, 200);
      const persistedBody = persistedResponse.body as any;
      const persistedKinds = persistedBody.observations.map((entry: any) => entry.observation.kind);
      expect.toContain(persistedKinds, 'generation');
      expect.toContain(persistedKinds, 'agent_run');

      const methodResponse = await handler({
        method: 'POST',
        url: `/api/observability/agents/${agent.agentId}/observations/runtime`,
      });
      expect.toEqual(methodResponse.status, 405);

      const invalidQueryResponse = await handler({
        method: 'GET',
        url: `/api/observability/agents/${agent.agentId}/observations/persisted?limit=0`,
      });
      expect.toEqual(invalidQueryResponse.status, 400);

      const missingAgentResponse = await handler({
        method: 'GET',
        url: '/api/observability/agents/missing-agent/metrics',
      });
      expect.toEqual(missingAgentResponse.status, 404);
    } finally {
      await cleanup();
    }
  });

export async function run() {
  return runner.run();
}
