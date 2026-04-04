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

const runner = new TestRunner('Observability Reader API');

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
  template?: any;
  registerTools?: (registry: ToolRegistry) => void;
  observability?: { enabled?: boolean };
}) {
  const workDir = path.join(TEST_ROOT, `obs-reader-work-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const storeDir = path.join(TEST_ROOT, `obs-reader-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  ensureCleanDir(workDir);
  ensureCleanDir(storeDir);

  const templates = new AgentTemplateRegistry();
  templates.register(
    params.template || {
      id: 'obs-reader-agent',
      systemPrompt: 'test reader api',
      tools: [],
      permission: { mode: 'auto' },
    }
  );

  const tools = new ToolRegistry();
  params.registerTools?.(tools);

  const agent = await Agent.create(
    {
      templateId: params.template?.id || 'obs-reader-agent',
      model: params.provider,
      sandbox: { kind: 'local', workDir, enforceBoundary: true },
      observability: params.observability,
    },
    {
      store: new JSONStore(storeDir),
      templateRegistry: templates,
      sandboxFactory: new SandboxFactory(),
      toolRegistry: tools,
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

function registerEchoTool(registry: ToolRegistry) {
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
}

function createApprovalProvider(finalText: string): ModelProvider {
  return new QueueStreamProvider([
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
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: finalText } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 } };
      yield { type: 'message_stop' };
    },
  ]);
}

runner
  .test('getObservationReader 暴露只读查询能力', async () => {
    const { agent, cleanup } = await createObservedAgent({
      provider: createApprovalProvider('reader done'),
      template: {
        id: 'obs-reader-deny',
        systemPrompt: 'use tools',
        tools: ['echo_tool'],
        permission: { mode: 'approval', requireApprovalTools: ['echo_tool'] as const },
      },
      registerTools: registerEchoTool,
    });

    const offPermissionRequired = agent.on('permission_required', async (evt: any) => {
      await evt.respond('deny', { note: 'reader api denied' });
    });

    try {
      const result = await agent.chat('run tool');
      expect.toEqual(result.status, 'ok');

      const reader = agent.getObservationReader() as any;
      expect.toBeTruthy(reader);
      expect.toEqual(typeof reader.getMetricsSnapshot, 'function');
      expect.toEqual(typeof reader.subscribe, 'function');
      expect.toEqual(typeof reader.listObservations, 'function');
      expect.toEqual(typeof reader.getRun, 'function');
      expect.toEqual(reader.record, undefined);

      const all = reader.listObservations();
      expect.toBeGreaterThanOrEqual(all.length, 3);
      expect.toEqual(all[0].seq, 0);
      expect.toEqual(all[all.length - 1].seq, all.length - 1);

      const runEnvelope = all.find((entry: any) => entry.observation.kind === 'agent_run');
      const toolEnvelope = all.find((entry: any) => entry.observation.kind === 'tool');
      expect.toBeTruthy(runEnvelope);
      expect.toBeTruthy(toolEnvelope);

      const byRun = reader.listObservations({ runId: runEnvelope.observation.runId });
      expect.toHaveLength(byRun, all.length);

      const byTrace = reader.listObservations({ traceId: runEnvelope.observation.traceId });
      expect.toHaveLength(byTrace, all.length);

      const byParent = reader.listObservations({ parentSpanId: runEnvelope.observation.spanId });
      expect.toHaveLength(byParent, all.length - 1);
      expect.toEqual(byParent[0].observation.kind, 'generation');
      expect.toEqual(byParent[1].observation.kind, 'tool');

      const errors = reader.listObservations({ statuses: ['error'] });
      expect.toHaveLength(errors, 1);
      expect.toEqual(errors[0].observation.kind, 'tool');

      const limited = reader.listObservations({ limit: 1 });
      expect.toHaveLength(limited, 1);
      expect.toEqual(limited[0].observation.kind, 'agent_run');

      const runView = reader.getRun(runEnvelope.observation.runId);
      expect.toBeTruthy(runView);
      expect.toEqual(runView.run.observation.kind, 'agent_run');
      expect.toHaveLength(runView.observations, all.length);
    } finally {
      offPermissionRequired();
      await cleanup();
    }
  })
  .test('reader.subscribe 支持 sinceSeq 历史补读', async () => {
    const provider = new QueueStreamProvider([
      async function* () {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reader subscribe' } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 2 } };
        yield { type: 'message_stop' };
      },
    ]);

    const { agent, cleanup } = await createObservedAgent({ provider });

    try {
      await agent.chat('hello');

      const reader = agent.getObservationReader();
      const envelopes = reader.listObservations();
      expect.toHaveLength(envelopes, 2);

      const replayed: any[] = [];
      for await (const envelope of reader.subscribe({ sinceSeq: envelopes[0].seq })) {
        replayed.push(envelope);
        break;
      }

      expect.toHaveLength(replayed, 1);
      expect.toEqual(replayed[0].seq, envelopes[1].seq);
      expect.toEqual(replayed[0].observation.kind, 'agent_run');
    } finally {
      await cleanup();
    }
  })
  .test('enabled=false 时 reader 仍可用但不会暴露观测数据', async () => {
    const provider = new QueueStreamProvider([
      async function* () {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'disabled reader' } };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', usage: { input_tokens: 1, output_tokens: 1 } };
        yield { type: 'message_stop' };
      },
    ]);

    const { agent, cleanup } = await createObservedAgent({
      provider,
      observability: { enabled: false },
    });

    try {
      await agent.chat('hello');

      const reader = agent.getObservationReader();
      expect.toHaveLength(reader.listObservations(), 0);
      expect.toEqual(reader.getRun('missing'), undefined);

      const snapshot = reader.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.totalTokens, 0);
      expect.toEqual(snapshot.totals.generations, 0);
    } finally {
      await cleanup();
    }
  });

export async function run() {
  return runner.run();
}
