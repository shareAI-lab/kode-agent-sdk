/**
 * 测试环境设置
 */

import path from 'path';
import fs from 'fs';
import {
  Agent,
  AgentConfig,
  AgentDependencies,
  JSONStore,
  SandboxFactory,
  AgentTemplateRegistry,
  ToolRegistry,
  builtin,
  AnthropicProvider,
} from '../../src';
import { MockProvider } from '../mock-provider';
import { TEST_ROOT, TEMPLATES, IntegrationConfig, loadIntegrationConfig } from './fixtures';

function registerBuiltinTools(registry: ToolRegistry) {
  const builtinTools = [
    ...builtin.fs(),
    ...builtin.bash(),
    ...builtin.todo(),
  ].filter(Boolean);

  for (const toolInstance of builtinTools) {
    registry.register(toolInstance.name, () => toolInstance);
  }
}

/**
 * 清理并创建目录
 */
export function ensureCleanDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

async function finishAgentForCleanup(agent: Agent, timeoutMs: number): Promise<void> {
  const internal = agent as any;
  let timer: NodeJS.Timeout | undefined;
  agent.schedule().clear();
  try {
    await Promise.race([
      (async () => {
        while (internal.processingPromise) {
          const processing = internal.processingPromise;
          await agent.interrupt({ note: 'test cleanup' });
          await processing;
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Agent test cleanup timed out; provider/tool must settle cooperatively')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await internal.sandbox.dispose?.();
  }
}

/**
 * 单元测试Agent设置选项
 */
export interface UnitTestAgentOptions {
  templateId?: keyof typeof TEMPLATES;
  customTemplate?: any;
  mockResponses?: string[];
  enableTodo?: boolean;
  workDir?: string;
  storeDir?: string;
  registerTools?: (registry: ToolRegistry) => void;
  registerTemplates?: (registry: AgentTemplateRegistry) => void;
}

/**
 * 创建单元测试用Agent（使用MockProvider）
 */
export async function createUnitTestAgent(options: UnitTestAgentOptions = {}) {
  const workDir = options.workDir || path.join(TEST_ROOT, `unit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const storeDir = options.storeDir || path.join(TEST_ROOT, `store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);

  ensureCleanDir(workDir);
  ensureCleanDir(storeDir);

  const store = new JSONStore(storeDir);
  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();

  registerBuiltinTools(tools);
  options.registerTools?.(tools);
  options.registerTemplates?.(templates);

  // 注册模板
  const template = options.customTemplate ||
                  (options.templateId ? TEMPLATES[options.templateId] : TEMPLATES.basic);

  const templateWithTodo = options.enableTodo
    ? {
        ...template,
        runtime: {
          ...(template.runtime || {}),
          todo: { enabled: true, remindIntervalSteps: 2, reminderOnStart: false },
        },
      }
    : template;
  templates.register(templateWithTodo);

  const deps: AgentDependencies = {
    store,
    templateRegistry: templates,
    sandboxFactory,
    toolRegistry: tools,
    modelFactory: () => new MockProvider((options.mockResponses || ['test']).map(text => ({ text }))),
  };

  const config: AgentConfig = {
    templateId: templateWithTodo.id,
    model: new MockProvider((options.mockResponses || ['test']).map(text => ({ text }))),
    sandbox: { kind: 'local', workDir, enforceBoundary: true },
  };

  const agent = await Agent.create(config, deps);

  return {
    agent,
    deps,
    config,
    workDir,
    storeDir,
    cleanup: async (timeoutMs = 2000) => {
      await finishAgentForCleanup(agent, timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const fs = require('fs');
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

/**
 * 集成测试Agent设置选项
 */
export interface IntegrationTestAgentOptions {
  templateId?: keyof typeof TEMPLATES;
  customTemplate?: any;
  workDir?: string;
  apiConfig?: Partial<IntegrationConfig>;
  registerTools?: (registry: ToolRegistry) => void;
  registerTemplates?: (registry: AgentTemplateRegistry) => void;
}

/**
 * 创建集成测试用Agent（使用真实API）
 */
export async function createIntegrationTestAgent(options: IntegrationTestAgentOptions = {}) {
  const workDir = options.workDir || path.join(TEST_ROOT, `int-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const storeDir = path.join(TEST_ROOT, `store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);

  // 仅在自动生成 workDir 时清空；外部传入的 workDir 可能已预置测试文件
  if (!options.workDir) {
    ensureCleanDir(workDir);
  } else {
    fs.mkdirSync(workDir, { recursive: true });
  }
  ensureCleanDir(storeDir);

  const store = new JSONStore(storeDir);
  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();

  registerBuiltinTools(tools);
  options.registerTools?.(tools);
  options.registerTemplates?.(templates);

  // 注册模板
  const template = options.customTemplate ||
                  (options.templateId ? TEMPLATES[options.templateId] : TEMPLATES.fullFeatured);
  templates.register(template);

  // 加载API配置
  const baseConfig = loadIntegrationConfig();
  const apiConfig = { ...baseConfig, ...options.apiConfig };

  const deps: AgentDependencies = {
    store,
    templateRegistry: templates,
    sandboxFactory,
    toolRegistry: tools,
    modelFactory: (config) => new AnthropicProvider(
      config.apiKey!,
      config.model,
      config.baseUrl ?? apiConfig.baseUrl,
      undefined,
      { reasoningTransport: 'text' }
    ),
  };

  const config: AgentConfig = {
    templateId: template.id,
    modelConfig: {
      provider: 'anthropic',
      apiKey: apiConfig.apiKey,
      baseUrl: apiConfig.baseUrl,
      model: apiConfig.model,
    },
    sandbox: { kind: 'local', workDir, enforceBoundary: true, watchFiles: true },
  };

  const agent = await Agent.create(config, deps);

  return {
    agent,
    deps,
    config,
    workDir,
    storeDir,
    cleanup: async (timeoutMs = 2000) => {
      await finishAgentForCleanup(agent, timeoutMs);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const fs = require('fs');
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

/**
 * 等待辅助函数
 */
export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 收集事件辅助函数
 */
export async function collectEvents<T>(
  agent: Agent,
  channels: Array<'progress' | 'control' | 'monitor'>,
  stopCondition: (event: any) => boolean,
  options?: Parameters<Agent['subscribe']>[1]
): Promise<T[]> {
  const events: T[] = [];

  for await (const envelope of agent.subscribe(channels, options)) {
    events.push(envelope.event as T);
    if (stopCondition(envelope.event)) {
      break;
    }
  }

  return events;
}
