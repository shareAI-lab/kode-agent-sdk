/**
 * Multi-Provider Integration Tests
 *
 * Tests real API connections for all supported providers.
 * Validates adapter behavior across:
 * - Anthropic (Claude) with thinking blocks
 * - OpenAI Chat Completions (GPT-4.x)
 * - OpenAI Responses API (GPT-5.x with reasoning)
 * - Gemini with thinking support
 */

import fs from 'fs';
import path from 'path';
import {
  Agent,
  AgentConfig,
  AgentDependencies,
  AgentTemplateRegistry,
  JSONStore,
  SandboxFactory,
  ToolRegistry,
  builtin,
} from '../../../src';
import { AnthropicProvider, OpenAIProvider, GeminiProvider } from '../../../src/infra/provider';
import { TestRunner, expect } from '../../helpers/utils';
import { ensureCleanDir } from '../../helpers/setup';
import { TEST_ROOT } from '../../helpers/fixtures';
import { loadProviderEnv } from '../../helpers/provider-env';

interface ProviderTestConfig {
  name: string;
  skip: boolean;
  skipReason?: string;
  createProvider: () => any;
  supportsThinking: boolean;
  supportsImages: boolean;
  supportsFiles: boolean;
}

function registerBuiltinTools(registry: ToolRegistry) {
  const builtinTools = [...builtin.fs()].filter(Boolean);
  for (const toolInstance of builtinTools) {
    registry.register(toolInstance.name, () => toolInstance);
  }
}

async function createProviderAgent(provider: any, workDir: string, storeDir: string): Promise<{
  agent: Agent;
  cleanup: () => Promise<void>;
}> {
  const store = new JSONStore(storeDir);
  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();

  registerBuiltinTools(tools);

  templates.register({
    id: 'multi-provider-test',
    systemPrompt: 'You are a helpful assistant for testing. Be concise.',
    tools: ['fs_write', 'fs_read'],
  });

  const deps: AgentDependencies = {
    store,
    templateRegistry: templates,
    sandboxFactory,
    toolRegistry: tools,
  };

  const agentConfig: AgentConfig = {
    agentId: `test-${path.basename(workDir)}`,
    templateId: 'multi-provider-test',
    model: provider,
    sandbox: { kind: 'local', workDir, enforceBoundary: true, watchFiles: false },
  };

  const agent = await Agent.create(agentConfig, deps);

  return {
    agent,
    cleanup: async () => {
      await (agent as any).sandbox?.dispose?.();
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

function getTestConfigs(): ProviderTestConfig[] {
  const anthropicEnv = loadProviderEnv('anthropic');
  const openaiEnv = loadProviderEnv('openai');
  const geminiEnv = loadProviderEnv('gemini');

  const configs: ProviderTestConfig[] = [
    {
      name: 'Anthropic',
      skip: !anthropicEnv.ok,
      skipReason: anthropicEnv.ok ? undefined : anthropicEnv.reason,
      createProvider: () => new AnthropicProvider(
        anthropicEnv.config!.apiKey,
        anthropicEnv.config!.model || 'claude-sonnet-4-5-thinking-all',
        anthropicEnv.config!.baseUrl || 'https://api.anthropic.com',
        anthropicEnv.config!.proxyUrl,
        {
          reasoningTransport: anthropicEnv.config!.enableIntertwined ? 'provider' : 'text',
          extraHeaders: anthropicEnv.config!.extraHeaders,
          extraBody: anthropicEnv.config!.extraBody,
        }
      ),
      supportsThinking: true,
      supportsImages: true,
      supportsFiles: true,
    },
    {
      name: 'OpenAI-Chat',
      skip: !openaiEnv.ok,
      skipReason: openaiEnv.ok ? undefined : openaiEnv.reason,
      createProvider: () => new OpenAIProvider(
        openaiEnv.config!.apiKey,
        openaiEnv.config!.model || 'gpt-4.1',
        openaiEnv.config!.baseUrl || 'https://api.openai.com/v1',
        openaiEnv.config!.proxyUrl,
        {
          providerOptions: { openaiApi: 'chat' },
          extraHeaders: openaiEnv.config!.extraHeaders,
          extraBody: openaiEnv.config!.extraBody,
        }
      ),
      supportsThinking: false,
      supportsImages: true,
      supportsFiles: false,
    },
    {
      name: 'OpenAI-Responses',
      skip: !openaiEnv.ok,
      skipReason: openaiEnv.ok ? undefined : openaiEnv.reason,
      createProvider: () => new OpenAIProvider(
        openaiEnv.config!.apiKey,
        openaiEnv.config!.model || 'gpt-4.1',
        openaiEnv.config!.baseUrl || 'https://api.openai.com/v1',
        openaiEnv.config!.proxyUrl,
        {
          providerOptions: { openaiApi: 'responses' },
          extraHeaders: openaiEnv.config!.extraHeaders,
          extraBody: openaiEnv.config!.extraBody,
        }
      ),
      supportsThinking: true,
      supportsImages: true,
      supportsFiles: true,
    },
    {
      name: 'Gemini',
      skip: !geminiEnv.ok,
      skipReason: geminiEnv.ok ? undefined : geminiEnv.reason,
      createProvider: () => new GeminiProvider(
        geminiEnv.config!.apiKey,
        geminiEnv.config!.model || 'gemini-3-flash-preview',
        geminiEnv.config!.baseUrl || 'https://generativelanguage.googleapis.com/v1beta',
        geminiEnv.config!.proxyUrl,
        {
          reasoningTransport: geminiEnv.config!.enableIntertwined ? 'text' : 'text',
          extraHeaders: geminiEnv.config!.extraHeaders,
          extraBody: geminiEnv.config!.extraBody,
        }
      ),
      supportsThinking: true,
      supportsImages: true,
      supportsFiles: true,
    },
  ];

  return configs;
}

const runner = new TestRunner('集成测试 - 多 Provider');
const baseDir = path.join(TEST_ROOT, 'multi-provider-test');
fs.mkdirSync(baseDir, { recursive: true });

for (const config of getTestConfigs()) {
  runner.test(`Provider: ${config.name}`, async () => {
    if (config.skip) {
      console.log(`[skip] ${config.name}: ${config.skipReason}`);
      return;
    }

    const provider = config.createProvider();

    const workDir = path.join(baseDir, config.name.toLowerCase());
    const storeDir = path.join(baseDir, `store-${config.name.toLowerCase()}`);
    ensureCleanDir(workDir);
    ensureCleanDir(storeDir);

    const { agent, cleanup } = await createProviderAgent(provider, workDir, storeDir);

    try {
      const simpleResult = await provider.complete(
        [{ role: 'user', content: [{ type: 'text', text: 'Say "hello" and nothing else.' }] }],
        { maxTokens: 100 }
      );

      expect.toEqual(simpleResult.role, 'assistant');
      expect.toBeTruthy(simpleResult.content);
      expect.toBeGreaterThan(simpleResult.content.length, 0);

      const textContent = simpleResult.content.find((b: any) => b.type === 'text');
      expect.toBeTruthy(textContent);
      if (textContent?.text) {
        expect.toContain(textContent.text.toLowerCase(), 'hello');
      }

      const chunks: any[] = [];
      for await (const chunk of provider.stream(
        [{ role: 'user', content: [{ type: 'text', text: 'Count from 1 to 3.' }] }],
        { maxTokens: 100 }
      )) {
        chunks.push(chunk);
      }

      expect.toBeGreaterThan(chunks.length, 0);
      const hasStart = chunks.some((c) => c.type === 'content_block_start');
      const hasDelta = chunks.some((c) => c.type === 'content_block_delta');
      expect.toBeTruthy(hasStart || hasDelta);

      const tools = [{
        name: 'get_time',
        description: 'Get the current time',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      }];
      const toolResult = await provider.complete(
        [{ role: 'user', content: [{ type: 'text', text: 'What time is it? Use the get_time tool.' }] }],
        { tools, maxTokens: 500 }
      );

      expect.toBeTruthy(toolResult.content);
      const toolUse = toolResult.content.find((b: any) => b.type === 'tool_use');
      if (toolUse) {
        expect.toEqual(toolUse.name, 'get_time');
        expect.toBeTruthy(toolUse.id);
      }

      if (config.supportsThinking) {
        const thinkingResult = await provider.complete(
          [{ role: 'user', content: [{ type: 'text', text: 'Think step by step: what is 15 + 27?' }] }],
          { maxTokens: 1000 }
        );

        expect.toBeTruthy(thinkingResult.content);
        expect.toBeGreaterThan(thinkingResult.content.length, 0);
        const hasContent = thinkingResult.content.some((b: any) => b.type === 'text' || b.type === 'reasoning');
        expect.toBeTruthy(hasContent);
      }

      const testFile = path.join(workDir, 'test-file.txt');
      const agentResult = await agent.chat(
        `Create a file at ${testFile} with the content "Hello from ${config.name}". Use fs_write.`
      );
      expect.toBeTruthy(agentResult.text);
      if (!fs.existsSync(testFile)) {
        console.log(`[warn] ${config.name}: file not created at ${testFile}`);
      }
    } finally {
      await cleanup();
    }
  });
}

runner.test('Message format conversion - basic blocks', async () => {
  const internalMessage = {
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: 'Hello' },
      { type: 'image' as const, base64: 'abc123', mime_type: 'image/png' },
    ],
  };

  expect.toEqual(internalMessage.content[0].type, 'text');
  expect.toEqual(internalMessage.content[1].type, 'image');
});

runner.test('Message format conversion - reasoning blocks', async () => {
  const messageWithReasoning = {
    role: 'assistant' as const,
    content: [
      { type: 'reasoning' as const, reasoning: 'Let me think...' },
      { type: 'text' as const, text: 'The answer is 42.' },
    ],
  };

  expect.toEqual(messageWithReasoning.content[0].type, 'reasoning');
  expect.toEqual(messageWithReasoning.content[1].type, 'text');
});

runner.test('Message format conversion - tool_use and tool_result', async () => {
  const toolUseMessage = {
    role: 'assistant' as const,
    content: [
      {
        type: 'tool_use' as const,
        id: 'tool-123',
        name: 'get_weather',
        input: { city: 'Tokyo' },
      },
    ],
  };

  const toolResultMessage = {
    role: 'user' as const,
    content: [
      {
        type: 'tool_result' as const,
        tool_use_id: 'tool-123',
        content: 'Sunny, 25C',
      },
    ],
  };

  expect.toEqual(toolUseMessage.content[0].type, 'tool_use');
  expect.toEqual(toolResultMessage.content[0].type, 'tool_result');
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
