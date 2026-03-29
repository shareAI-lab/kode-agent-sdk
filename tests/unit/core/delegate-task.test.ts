import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, AgentTemplateRegistry, JSONStore, SandboxFactory, ToolRegistry, builtin } from '../../../src';
import { createUnitTestAgent } from '../../helpers/setup';
import { MockProvider } from '../../mock-provider';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('Agent 子任务委派');

runner
  .test('delegateTask 使用 task_run 工具创建子 agent', async () => {
    const templates = [
      {
        id: 'unit-sub-writer',
        systemPrompt: '你是一个子代理，只需原样复述 prompt。',
      },
    ];

    const taskTool = builtin.task(templates);
    if (!taskTool) {
      throw new Error('无法创建 task_run 工具');
    }

    const { agent, deps, cleanup } = await createUnitTestAgent({
      customTemplate: {
        id: 'unit-main-agent',
        systemPrompt: '你可以通过 task_run 委派任务。',
        tools: ['task_run'],
      },
      registerTools: (registry) => {
        registry.register(taskTool.name, () => taskTool);
      },
      registerTemplates: (registry) => {
        registry.register(templates[0]);
      },
      mockResponses: ['主代理响应', '子代理输出'],
    });

    const result = await agent.delegateTask({
      templateId: 'unit-sub-writer',
      prompt: '请返回“子代理响应成功”',
    });

    expect.toEqual(result.status, 'ok');
    expect.toBeTruthy(result.text?.includes('子代理输出'));
    expect.toEqual(result.permissionIds?.length ?? 0, 0);

    expect.toBeTruthy(deps.templateRegistry.has('unit-sub-writer'));

    await cleanup();
  })
  .test('delegateTask 在未提供 modelFactory 时可继承自定义 ModelProvider', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-delegate-work-'));
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-delegate-store-'));

    const templates = new AgentTemplateRegistry();
    templates.register({
      id: 'unit-main-custom-provider',
      systemPrompt: '主代理',
      tools: [],
    });
    templates.register({
      id: 'unit-sub-custom-provider',
      systemPrompt: '子代理',
      tools: [],
    });

    const deps = {
      store: new JSONStore(storeDir),
      templateRegistry: templates,
      sandboxFactory: new SandboxFactory(),
      toolRegistry: new ToolRegistry(),
    };

    const agent = await Agent.create({
      templateId: 'unit-main-custom-provider',
      model: new MockProvider([{ text: 'custom-provider-ok' }]),
      sandbox: { kind: 'local', workDir, enforceBoundary: true },
    }, deps);

    try {
      const result = await agent.delegateTask({
        templateId: 'unit-sub-custom-provider',
        prompt: '请处理该任务',
      });
      expect.toEqual(result.status, 'ok');
      expect.toContain(result.text || '', 'custom-provider-ok');
    } finally {
      await (agent as any).sandbox?.dispose?.();
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  })
  .test('delegateTask 的字符串 model 覆盖应沿用父 provider', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-delegate-work-'));
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-delegate-store-'));

    const templates = new AgentTemplateRegistry();
    templates.register({
      id: 'unit-main-model-override',
      systemPrompt: '主代理',
      tools: [],
    });
    templates.register({
      id: 'unit-sub-model-override',
      systemPrompt: '子代理',
      tools: [],
    });

    const deps = {
      store: new JSONStore(storeDir),
      templateRegistry: templates,
      sandboxFactory: new SandboxFactory(),
      toolRegistry: new ToolRegistry(),
      modelFactory: (config: any) => {
        if (config.provider !== 'mock') {
          throw new Error(`unexpected provider: ${config.provider}`);
        }
        return new MockProvider([{ text: `provider=${config.provider};model=${config.model}` }]);
      },
    };

    const agent = await Agent.create({
      templateId: 'unit-main-model-override',
      model: new MockProvider([{ text: 'parent' }]),
      sandbox: { kind: 'local', workDir, enforceBoundary: true },
    }, deps);

    try {
      const result = await agent.delegateTask({
        templateId: 'unit-sub-model-override',
        prompt: '请处理该任务',
        model: 'mock-v2',
      });
      expect.toEqual(result.status, 'ok');
      expect.toContain(result.text || '', 'provider=mock;model=mock-v2');
    } finally {
      await (agent as any).sandbox?.dispose?.();
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  })
  .test('delegateTask 支持 provider+model 对象覆盖', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-delegate-work-'));
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kode-delegate-store-'));

    const templates = new AgentTemplateRegistry();
    templates.register({
      id: 'unit-main-provider-model-override',
      systemPrompt: '主代理',
      tools: [],
    });
    templates.register({
      id: 'unit-sub-provider-model-override',
      systemPrompt: '子代理',
      tools: [],
    });

    const deps = {
      store: new JSONStore(storeDir),
      templateRegistry: templates,
      sandboxFactory: new SandboxFactory(),
      toolRegistry: new ToolRegistry(),
      modelFactory: (config: any) => new MockProvider([{ text: `provider=${config.provider};model=${config.model}` }]),
    };

    const agent = await Agent.create({
      templateId: 'unit-main-provider-model-override',
      model: new MockProvider([{ text: 'parent' }]),
      sandbox: { kind: 'local', workDir, enforceBoundary: true },
    }, deps);

    try {
      const result = await agent.delegateTask({
        templateId: 'unit-sub-provider-model-override',
        prompt: '请处理该任务',
        model: { provider: 'mock-alt', model: 'mock-alt-v2' },
      });
      expect.toEqual(result.status, 'ok');
      expect.toContain(result.text || '', 'provider=mock-alt;model=mock-alt-v2');
    } finally {
      await (agent as any).sandbox?.dispose?.();
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  })
  .test('task_run 可透传 model 覆盖参数到 delegateTask', async () => {
    const taskTool = builtin.task([{ id: 'researcher' }]);
    if (!taskTool) {
      throw new Error('无法创建 task_run 工具');
    }

    let captured: any;
    const result = await taskTool.exec(
      {
        description: '调研',
        prompt: '请调研竞品',
        agentTemplateId: 'researcher',
        model: { provider: 'openai', model: 'gpt-4.1-mini' },
      },
      {
        agentId: 'unit-agent',
        sandbox: {} as any,
        agent: {
          delegateTask: async (config: any) => {
            captured = config;
            return { status: 'ok', text: 'done', permissionIds: [] };
          },
        },
      } as any
    );

    expect.toEqual((result as any).status, 'ok');
    expect.toEqual(captured.model.provider, 'openai');
    expect.toEqual(captured.model.model, 'gpt-4.1-mini');
  });

export async function run() {
  return runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
