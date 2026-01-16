import path from 'path';

import {
  Agent,
  AgentConfig,
  AgentDependencies,
  AgentTemplateRegistry,
  AnthropicProvider,
  GeminiProvider,
  JSONStore,
  OpenAIProvider,
  SandboxFactory,
  ToolRegistry,
} from '../../src';
import { MonitorErrorEvent } from '../../src/core/types';
import { PermissionConfig } from '../../src/core/template';
import { ensureCleanDir } from './setup';
import { TEST_ROOT } from './fixtures';
import { ProviderId } from './provider-env';
import { registerProviderTestTools } from './provider-tools';

export interface ProviderTestAgentOptions {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseUrl?: string;
  proxyUrl?: string;
  permission?: PermissionConfig;
  tools?: string[];
  workDir?: string;
  storeDir?: string;
}

export async function createProviderTestAgent(options: ProviderTestAgentOptions) {
  const workDir = options.workDir || path.join(TEST_ROOT, `provider-${options.provider}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const storeDir = options.storeDir || path.join(TEST_ROOT, `store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);

  ensureCleanDir(workDir);
  ensureCleanDir(storeDir);

  const store = new JSONStore(storeDir);
  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();

  registerProviderTestTools(tools);

  const templateId = `provider-${options.provider}-test`;
  const template = {
    id: templateId,
    systemPrompt: 'You are a provider test agent. When asked to use a tool, you MUST call the requested tool exactly once before replying.',
    tools: options.tools ?? ['always_ok', 'always_fail'],
    permission: options.permission ?? { mode: 'auto' as const },
  };
  templates.register(template);

  const deps: AgentDependencies = {
    store,
    templateRegistry: templates,
    sandboxFactory,
    toolRegistry: tools,
    modelFactory: (config) => {
      const apiKey = config.apiKey ?? options.apiKey;
      const model = config.model ?? options.model;
      const baseUrl = config.baseUrl ?? options.baseUrl;
      const proxyUrl = config.proxyUrl ?? options.proxyUrl;
      switch (options.provider) {
        case 'openai':
          return new OpenAIProvider(apiKey!, model, baseUrl, proxyUrl);
        case 'gemini':
          return new GeminiProvider(apiKey!, model, baseUrl, proxyUrl);
        case 'anthropic':
          return new AnthropicProvider(apiKey!, model, baseUrl, proxyUrl);
        default:
          throw new Error(`Unsupported provider: ${options.provider}`);
      }
    },
  };

  const config: AgentConfig = {
    templateId,
    modelConfig: {
      provider: options.provider,
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: options.baseUrl,
      proxyUrl: options.proxyUrl,
    },
    sandbox: { kind: 'local', workDir, enforceBoundary: true, watchFiles: false },
  };

  const agent = await Agent.create(config, deps);
  const monitorErrors: MonitorErrorEvent[] = [];
  const unsubscribeError = agent.on('error', (event) => {
    monitorErrors.push(event as MonitorErrorEvent);
  });

  return {
    agent,
    deps,
    config,
    workDir,
    storeDir,
    monitorErrors,
    cleanup: async () => {
      unsubscribeError();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const fs = require('fs');
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}
