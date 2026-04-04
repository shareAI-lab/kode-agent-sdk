import fs from 'node:fs';
import path from 'node:path';
import {
  Agent,
  AgentTemplateRegistry,
  ObservabilityConfig,
  JSONStore,
  SandboxFactory,
  ToolRegistry,
  AgentMetricsSnapshot,
} from '../../../src';
import { ModelConfig, ModelProvider, ModelResponse, ModelStreamChunk } from '../../../src/infra/provider';
import { TestRunner, expect } from '../../helpers/utils';
import { TEST_ROOT } from '../../helpers/fixtures';
import { ensureCleanDir } from '../../helpers/setup';

const runner = new TestRunner('Observability Core Observation');

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

function createGenerationUsage() {
  return {
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
    reasoningTokens: 3,
    cache: {
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      provider: {},
    },
    cost: {
      inputCost: 0.00001,
      outputCost: 0.00002,
      cacheWriteCost: 0,
      totalCost: 0.00003,
      cacheSavings: 0,
      currency: 'USD' as const,
    },
    request: {
      startTime: Date.now() - 20,
      endTime: Date.now(),
      latencyMs: 20,
      timeToFirstTokenMs: 5,
      requestId: 'req-observe-1',
      modelUsed: 'queue-stream-provider',
      stopReason: 'end_turn',
      retryCount: 0,
    },
  };
}

async function createObservedAgent(params: {
  provider: ModelProvider;
  template?: any;
  registerTools?: (registry: ToolRegistry) => void;
  observability?: ObservabilityConfig;
}) {
  const workDir = path.join(TEST_ROOT, `obs-work-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const storeDir = path.join(TEST_ROOT, `obs-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  ensureCleanDir(workDir);
  ensureCleanDir(storeDir);
  const store = new JSONStore(storeDir);

  const templates = new AgentTemplateRegistry();
  templates.register(
    params.template || {
      id: 'obs-agent',
      systemPrompt: 'test observability',
      tools: [],
      permission: { mode: 'auto' },
    }
  );

  const tools = new ToolRegistry();
  params.registerTools?.(tools);

  const agent = await Agent.create(
    {
      templateId: params.template?.id || 'obs-agent',
      model: params.provider,
      sandbox: { kind: 'local', workDir, enforceBoundary: true },
      observability: params.observability,
    },
    {
      store,
      templateRegistry: templates,
      sandboxFactory: new SandboxFactory(),
      toolRegistry: tools,
    }
  );

  return {
    agent,
    store,
    cleanup: async () => {
      await (agent as any).sandbox?.dispose?.();
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

async function collectObservations(agent: Agent, expected: number) {
  const collected: any[] = [];
  for await (const envelope of agent.subscribeObservations()) {
    collected.push(envelope);
    if (collected.length >= expected) {
      break;
    }
  }
  return collected;
}

runner
  .test('metrics snapshot 暴露 generation token/cost/latency', async () => {
    const extendedUsage = createGenerationUsage();
    const provider = new QueueStreamProvider([
      async function* () {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'observed reply' } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', usage: { input_tokens: 11, output_tokens: 7 } };
        yield { type: 'message_stop', stop_reason: 'end_turn', extendedUsage };
      },
    ]);

    const { agent, cleanup } = await createObservedAgent({ provider });
    try {
      const result = await agent.chat('hello');
      expect.toEqual(result.status, 'ok');
      expect.toContain(result.text || '', 'observed reply');

      const snapshot: AgentMetricsSnapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.inputTokens, 11);
      expect.toEqual(snapshot.totals.outputTokens, 7);
      expect.toEqual(snapshot.totals.totalTokens, 18);
      expect.toEqual(snapshot.totals.reasoningTokens, 3);
      expect.toEqual(snapshot.totals.totalCostUsd, 0.00003);
      expect.toEqual(snapshot.totals.generations, 1);
      expect.toEqual(snapshot.lastGeneration?.requestId, 'req-observe-1');
      expect.toEqual(snapshot.lastGeneration?.stopReason, 'end_turn');
      expect.toEqual(snapshot.lastGeneration?.latencyMs, 20);

      const observations = await collectObservations(agent, 2);
      expect.toEqual(observations[0].observation.kind, 'generation');
      expect.toEqual(observations[1].observation.kind, 'agent_run');
      expect.toEqual((observations[0].observation as any).rawUsage, undefined);
      expect.toEqual(
        (observations[0].observation as any).metadata?.__debug?.extendedUsage?.request?.requestId,
        'req-observe-1'
      );
    } finally {
      await cleanup();
    }
  })
  .test('generation observation 的 inputSummary 使用真实模型输入而不是 assistant 输出', async () => {
    const provider = new QueueStreamProvider([
      async function* () {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'assistant final reply' } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', usage: { input_tokens: 2, output_tokens: 4 } };
        yield { type: 'message_stop' };
      },
    ]);

    const { agent, cleanup } = await createObservedAgent({
      provider,
      observability: {
        capture: {
          generationInput: 'full',
          generationOutput: 'full',
        },
      },
    });

    try {
      const result = await agent.chat('user asks for summary');
      expect.toEqual(result.status, 'ok');

      const observations = await collectObservations(agent, 2);
      const generation = observations.find((entry) => entry.observation.kind === 'generation')?.observation as any;
      expect.toBeTruthy(generation);
      expect.toEqual(generation.inputSummary[generation.inputSummary.length - 1].role, 'user');
      expect.toContain(generation.inputSummary[generation.inputSummary.length - 1].content[0].text, 'user asks for summary');
      expect.toContain(generation.outputSummary[0].text, 'assistant final reply');
    } finally {
      await cleanup();
    }
  })
  .test('subscribeObservations 支持 kind 过滤与历史回放', async () => {
    const provider = new QueueStreamProvider([
      async function* () {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'filter test' } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', usage: { input_tokens: 2, output_tokens: 2 } };
        yield { type: 'message_stop' };
      },
    ]);

    const { agent, cleanup } = await createObservedAgent({ provider });
    try {
      await agent.chat('hello');

      const filtered: any[] = [];
      for await (const envelope of agent.subscribeObservations({ kinds: ['generation'] })) {
        filtered.push(envelope);
        break;
      }

      expect.toHaveLength(filtered, 1);
      expect.toEqual(filtered[0].observation.kind, 'generation');
    } finally {
      await cleanup();
    }
  })
  .test('tool observation 会进入 metrics snapshot 与 observation 流', async () => {
    const provider = new QueueStreamProvider([
      async function* () {
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool-1', name: 'echo_tool', input: {} },
        };
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"value":"hi"}' },
        };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_stop' };
      },
      async function* () {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tool finished' } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'message_stop' };
      },
    ]);

    const { agent, cleanup } = await createObservedAgent({
      provider,
      template: {
        id: 'obs-tool-agent',
        systemPrompt: 'use tools',
        tools: ['echo_tool'],
        permission: { mode: 'auto' },
      },
      registerTools: (registry) => {
        registry.register('echo_tool', () => ({
          name: 'echo_tool',
          description: 'echo value',
          input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
          async exec(args: any) {
            return { echoed: args.value };
          },
          toDescriptor() {
            return { source: 'registered' as const, name: 'echo_tool', registryId: 'echo_tool' };
          },
        }));
      },
    });

    try {
      const result = await agent.chat('run tool');
      expect.toEqual(result.status, 'ok');
      expect.toContain(result.text || '', 'tool finished');

      const snapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.toolCalls, 1);
      expect.toEqual(snapshot.totals.toolErrors, 0);

      const observations = await collectObservations(agent, 4);
      expect.toContain(observations.map((o) => o.observation.kind), 'tool');
    } finally {
      await cleanup();
    }
  })
  .test('subagent observation 会记录 childRunId', async () => {
    const parentProvider = new QueueStreamProvider([]);
    const { agent, store, cleanup } = await createObservedAgent({
      provider: parentProvider,
      template: {
        id: 'obs-parent-agent',
        systemPrompt: 'parent',
        tools: [],
        permission: { mode: 'auto' },
      },
    });

    const templates = (agent as any).deps.templateRegistry as AgentTemplateRegistry;
    templates.register({ id: 'obs-child-agent', systemPrompt: 'child' });

    try {
      const result = await agent.delegateTask({
        templateId: 'obs-child-agent',
        prompt: 'child work',
        model: new QueueStreamProvider([
          async function* () {
            yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child ok' } };
            yield { type: 'content_block_stop', index: 0 };
            yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 } };
            yield { type: 'message_stop' };
          },
        ]),
      });
      expect.toEqual(result.status, 'ok');

      const observations = await collectObservations(agent, 1);
      expect.toEqual(observations[0].observation.kind, 'subagent');
      expect.toBeTruthy(observations[0].observation.childRunId);
      const childInfo = await store.loadInfo(observations[0].observation.childAgentId);
      expect.toBeTruthy(childInfo);
      expect.toEqual(childInfo?.metadata?.metadata?.__observationTraceId, undefined);
      expect.toEqual(childInfo?.metadata?.metadata?.__observationParentSpanId, undefined);
    } finally {
      await cleanup();
    }
  })
  .test('sink 失败不会影响主流程与 snapshot', async () => {
    const provider = new QueueStreamProvider([
      async function* () {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sink safe' } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', usage: { input_tokens: 3, output_tokens: 4 } };
        yield { type: 'message_stop' };
      },
    ]);

    const { agent, cleanup } = await createObservedAgent({
      provider,
      observability: {
        sink: {
          onObservation() {
            throw new Error('sink failure');
          },
        },
      },
    });

    try {
      const result = await agent.chat('hello');
      expect.toEqual(result.status, 'ok');
      expect.toContain(result.text || '', 'sink safe');

      const snapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.totalTokens, 7);
      expect.toEqual(snapshot.totals.generations, 1);
    } finally {
      await cleanup();
    }
  })
  .test('enabled=false 时不记录 snapshot 与 observation', async () => {
    const provider = new QueueStreamProvider([
      async function* () {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'disabled' } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', usage: { input_tokens: 5, output_tokens: 6 } };
        yield { type: 'message_stop' };
      },
    ]);

    const { agent, cleanup } = await createObservedAgent({
      provider,
      observability: { enabled: false },
    });

    try {
      const result = await agent.chat('hello');
      expect.toEqual(result.status, 'ok');

      const snapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.totalTokens, 0);
      expect.toEqual(snapshot.totals.generations, 0);

      const observations = await collectObservations(agent, 1);
      expect.toHaveLength(observations, 0);
    } finally {
      await cleanup();
    }
  });

export async function run() {
  return runner.run();
}
