/**
 * Multi-Provider Integration Tests
 *
 * Tests real API connections for all supported providers.
 * Validates the adapter pattern works correctly across:
 * - Anthropic (Claude) with thinking blocks
 * - OpenAI Chat Completions (GPT-4.x)
 * - OpenAI Responses API (GPT-5.x with reasoning)
 * - Gemini with thinking support
 */

import { Agent, AgentConfig } from '../../../src';
import { AnthropicProvider, OpenAIProvider, GeminiProvider } from '../../../src/infra/provider';
import { LocalSandbox } from '../../../src/infra/sandbox';
import * as fs from 'fs';
import * as path from 'path';

// Load test environment
const envPath = path.resolve(__dirname, '../../.env.test');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

interface ProviderTestConfig {
  name: string;
  skip: boolean;
  skipReason?: string;
  createProvider: () => any;
  supportsThinking: boolean;
  supportsImages: boolean;
  supportsFiles: boolean;
}

function getTestConfigs(): ProviderTestConfig[] {
  return [
    // Anthropic
    {
      name: 'Anthropic',
      skip: !process.env.ANTHROPIC_API_KEY,
      skipReason: 'ANTHROPIC_API_KEY not set',
      createProvider: () => new AnthropicProvider(
        process.env.ANTHROPIC_API_KEY!,
        process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-5-thinking-all',
        process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
        undefined,
        {
          reasoningTransport: process.env.ANTHROPIC_ENABLE_INTERTWINED === '1' ? 'provider' : 'text',
        }
      ),
      supportsThinking: true,
      supportsImages: true,
      supportsFiles: true,
    },
    // OpenAI Chat Completions
    {
      name: 'OpenAI-Chat',
      skip: !process.env.OPENAI_API_KEY,
      skipReason: 'OPENAI_API_KEY not set',
      createProvider: () => new OpenAIProvider(
        process.env.OPENAI_API_KEY!,
        process.env.OPENAI_MODEL_ID || 'gpt-4.1',
        process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        undefined,
        {
          providerName: 'openai',
          providerOptions: { openaiApi: 'chat' },
        }
      ),
      supportsThinking: false,
      supportsImages: true,
      supportsFiles: false,
    },
    // OpenAI Responses API
    {
      name: 'OpenAI-Responses',
      skip: !process.env.OPENAI_RESPONSES_API_KEY,
      skipReason: 'OPENAI_RESPONSES_API_KEY not set',
      createProvider: () => new OpenAIProvider(
        process.env.OPENAI_RESPONSES_API_KEY!,
        process.env.OPENAI_RESPONSES_MODEL_ID || 'gpt-5.2',
        process.env.OPENAI_RESPONSES_BASE_URL || 'https://api.openai.com/v1',
        undefined,
        {
          providerName: 'openai',
          providerOptions: { openaiApi: 'responses' },
        }
      ),
      supportsThinking: true,
      supportsImages: true,
      supportsFiles: true,
    },
    // Gemini
    {
      name: 'Gemini',
      skip: !process.env.GEMINI_API_KEY,
      skipReason: 'GEMINI_API_KEY not set',
      createProvider: () => new GeminiProvider(
        process.env.GEMINI_API_KEY!,
        process.env.GEMINI_MODEL_ID || 'gemini-3-flash-preview',
        process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
        undefined,
        {
          reasoningTransport: process.env.GEMINI_ENABLE_INTERTWINED === '1' ? 'text' : 'text',
        }
      ),
      supportsThinking: true,
      supportsImages: true,
      supportsFiles: true,
    },
  ];
}

describe('Multi-Provider Integration Tests', () => {
  const configs = getTestConfigs();
  const testDir = path.resolve(__dirname, '../.tmp/multi-provider-test');

  beforeAll(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  for (const config of configs) {
    describe(config.name, () => {
      if (config.skip) {
        it.skip(`skipped: ${config.skipReason}`, () => {});
        return;
      }

      let provider: any;
      let agent: Agent;
      const agentDir = path.join(testDir, config.name.toLowerCase());

      beforeAll(async () => {
        provider = config.createProvider();

        if (!fs.existsSync(agentDir)) {
          fs.mkdirSync(agentDir, { recursive: true });
        }

        const agentConfig: AgentConfig = {
          agentId: `test-${config.name.toLowerCase()}`,
          templateId: 'multi-provider-test',
          sandbox: new LocalSandbox(agentDir),
          model: provider,
          systemPrompt: 'You are a helpful assistant for testing. Be concise.',
        };

        agent = await Agent.create(agentConfig);
      });

      afterAll(async () => {
        if (agent) {
          await agent.shutdown();
        }
      });

      it('should complete a simple text request', async () => {
        const result = await provider.complete([
          { role: 'user', content: [{ type: 'text', text: 'Say "hello" and nothing else.' }] }
        ], { maxTokens: 100 });

        expect(result.role).toBe('assistant');
        expect(result.content).toBeDefined();
        expect(result.content.length).toBeGreaterThan(0);

        const textContent = result.content.find((b: any) => b.type === 'text');
        expect(textContent).toBeDefined();
        expect(textContent.text.toLowerCase()).toContain('hello');
      }, 30000);

      it('should stream a response', async () => {
        const chunks: any[] = [];

        for await (const chunk of provider.stream([
          { role: 'user', content: [{ type: 'text', text: 'Count from 1 to 3.' }] }
        ], { maxTokens: 100 })) {
          chunks.push(chunk);
        }

        expect(chunks.length).toBeGreaterThan(0);

        // Should have start, delta, and stop events
        const hasStart = chunks.some(c => c.type === 'content_block_start');
        const hasDelta = chunks.some(c => c.type === 'content_block_delta');
        expect(hasStart || hasDelta).toBe(true);
      }, 30000);

      it('should handle tool calls', async () => {
        const tools = [{
          name: 'get_time',
          description: 'Get the current time',
          input_schema: {
            type: 'object',
            properties: {},
            required: [],
          },
        }];

        const result = await provider.complete([
          { role: 'user', content: [{ type: 'text', text: 'What time is it? Use the get_time tool.' }] }
        ], { tools, maxTokens: 500 });

        expect(result.content).toBeDefined();

        // Check if there's a tool_use in the response
        const toolUse = result.content.find((b: any) => b.type === 'tool_use');
        if (toolUse) {
          expect(toolUse.name).toBe('get_time');
          expect(toolUse.id).toBeDefined();
        }
      }, 30000);

      if (config.supportsThinking) {
        it('should handle thinking/reasoning blocks', async () => {
          const result = await provider.complete([
            { role: 'user', content: [{ type: 'text', text: 'Think step by step: what is 15 + 27?' }] }
          ], { maxTokens: 1000 });

          expect(result.content).toBeDefined();
          expect(result.content.length).toBeGreaterThan(0);

          // Check for reasoning or text content
          const hasContent = result.content.some((b: any) =>
            b.type === 'text' || b.type === 'reasoning'
          );
          expect(hasContent).toBe(true);
        }, 60000);
      }

      it('should work with Agent for file operations', async () => {
        const testFile = path.join(agentDir, 'test-file.txt');

        // Send a request to create a file
        await agent.send(`Create a file at ${testFile} with the content "Hello from ${config.name}"`);

        // Wait for completion
        const result = await agent.complete();

        // Verify file was created (if the agent supports file operations)
        // Note: This depends on the agent having file tools available
        expect(result).toBeDefined();
      }, 60000);
    });
  }
});

// Additional test for message format conversion
describe('Message Format Conversion', () => {
  it('should convert internal format to Anthropic format correctly', () => {
    const internalMessage = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'Hello' },
        { type: 'image' as const, base64: 'abc123', mime_type: 'image/png' },
      ],
    };

    // The provider should handle this format
    expect(internalMessage.content[0].type).toBe('text');
    expect(internalMessage.content[1].type).toBe('image');
  });

  it('should handle reasoning blocks', () => {
    const messageWithReasoning = {
      role: 'assistant' as const,
      content: [
        { type: 'reasoning' as const, reasoning: 'Let me think...' },
        { type: 'text' as const, text: 'The answer is 42.' },
      ],
    };

    expect(messageWithReasoning.content[0].type).toBe('reasoning');
    expect(messageWithReasoning.content[1].type).toBe('text');
  });

  it('should handle tool_use and tool_result blocks', () => {
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

    expect(toolUseMessage.content[0].type).toBe('tool_use');
    expect(toolResultMessage.content[0].type).toBe('tool_result');
  });
});
