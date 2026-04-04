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

const runner = new TestRunner('Observability Approval Metadata');

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
}) {
  const workDir = path.join(TEST_ROOT, `obs-approval-work-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const storeDir = path.join(TEST_ROOT, `obs-approval-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  ensureCleanDir(workDir);
  ensureCleanDir(storeDir);

  const templates = new AgentTemplateRegistry();
  templates.register(
    params.template || {
      id: 'obs-approval-agent',
      systemPrompt: 'test approval observability',
      tools: [],
      permission: { mode: 'auto' },
    }
  );

  const tools = new ToolRegistry();
  params.registerTools?.(tools);

  const agent = await Agent.create(
    {
      templateId: params.template?.id || 'obs-approval-agent',
      model: params.provider,
      sandbox: { kind: 'local', workDir, enforceBoundary: true },
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

async function collectToolObservation(agent: Agent) {
  for await (const envelope of agent.subscribeObservations({ kinds: ['tool'] })) {
    return envelope.observation as any;
  }
  return undefined;
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
  .test('tool observation 记录 approved approval metadata 与快照聚合', async () => {
    const { agent, cleanup } = await createObservedAgent({
      provider: createApprovalProvider('approval done'),
      template: {
        id: 'obs-approval-allow',
        systemPrompt: 'use tools',
        tools: ['echo_tool'],
        permission: { mode: 'approval', requireApprovalTools: ['echo_tool'] as const },
      },
      registerTools: registerEchoTool,
    });

    const offPermissionRequired = agent.on('permission_required', async (evt: any) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await evt.respond('allow', { note: 'Bearer sk-secret-value approved' });
    });

    try {
      const result = await agent.chat('run tool');
      expect.toEqual(result.status, 'ok');

      const toolObservation = await collectToolObservation(agent);
      expect.toEqual(toolObservation.kind, 'tool');
      expect.toEqual(toolObservation.approval.status, 'approved');
      expect.toEqual(toolObservation.approval.required, true);
      expect.toBeTruthy(toolObservation.approval.waitMs !== undefined);
      expect.toBeGreaterThanOrEqual(toolObservation.approval.waitMs, 0);
      expect.toBeTruthy(toolObservation.approval.noteSummary);
      expect.toContain(toolObservation.approval.noteSummary, 'sk-***');
      expect.toBeFalsy(toolObservation.approval.noteSummary.includes('sk-secret-value'));

      const snapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.approvalRequests, 1);
      expect.toEqual(snapshot.totals.approvalDenials, 0);
      expect.toBeGreaterThanOrEqual(snapshot.totals.approvalWaitMsTotal, 0);
    } finally {
      offPermissionRequired();
      await cleanup();
    }
  })
  .test('tool observation 记录 denied approval metadata 与拒绝聚合', async () => {
    const { agent, cleanup } = await createObservedAgent({
      provider: createApprovalProvider('approval denied'),
      template: {
        id: 'obs-approval-deny',
        systemPrompt: 'use tools',
        tools: ['echo_tool'],
        permission: { mode: 'approval', requireApprovalTools: ['echo_tool'] as const },
      },
      registerTools: registerEchoTool,
    });

    const offPermissionRequired = agent.on('permission_required', async (evt: any) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await evt.respond('deny', { note: 'sk-secret-value deny this call' });
    });

    try {
      const result = await agent.chat('run tool');
      expect.toEqual(result.status, 'ok');

      const toolObservation = await collectToolObservation(agent);
      expect.toEqual(toolObservation.kind, 'tool');
      expect.toEqual(toolObservation.approval.status, 'denied');
      expect.toEqual(toolObservation.approval.required, true);
      expect.toBeTruthy(toolObservation.approval.waitMs !== undefined);
      expect.toBeGreaterThanOrEqual(toolObservation.approval.waitMs, 0);
      expect.toBeTruthy(toolObservation.approval.noteSummary);
      expect.toContain(toolObservation.approval.noteSummary, 'sk-***');
      expect.toBeFalsy(toolObservation.approval.noteSummary.includes('sk-secret-value'));

      const snapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.approvalRequests, 1);
      expect.toEqual(snapshot.totals.approvalDenials, 1);
      expect.toBeGreaterThanOrEqual(snapshot.totals.approvalWaitMsTotal, 0);
    } finally {
      offPermissionRequired();
      await cleanup();
    }
  })
  .test('无需审批的工具 observation 标记为 not_required', async () => {
    const { agent, cleanup } = await createObservedAgent({
      provider: createApprovalProvider('no approval needed'),
      template: {
        id: 'obs-approval-not-required',
        systemPrompt: 'use tools',
        tools: ['echo_tool'],
        permission: { mode: 'auto' },
      },
      registerTools: registerEchoTool,
    });

    try {
      const result = await agent.chat('run tool');
      expect.toEqual(result.status, 'ok');

      const toolObservation = await collectToolObservation(agent);
      expect.toEqual(toolObservation.kind, 'tool');
      expect.toEqual(toolObservation.approval.status, 'not_required');
      expect.toEqual(toolObservation.approval.required, false);

      const snapshot = agent.getMetricsSnapshot();
      expect.toEqual(snapshot.totals.approvalRequests, 0);
      expect.toEqual(snapshot.totals.approvalDenials, 0);
      expect.toEqual(snapshot.totals.approvalWaitMsTotal, 0);
    } finally {
      await cleanup();
    }
  });

export async function run() {
  return runner.run();
}
