import { AnthropicProvider, GeminiProvider, OpenAIProvider } from '../../../src/infra/provider';
import { Message } from '../../../src/core/types';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('Provider/Contract');

const messages: Message[] = [
  { role: 'system', content: [{ type: 'text', text: 'sys-msg' }] },
  { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'always_ok', input: { value: 'ping' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: { ok: true, data: { foo: 'bar' } } }] },
];

const tools = [
  {
    name: 'always_ok',
    description: 'ok',
    input_schema: { type: 'object', properties: { value: { type: 'string' } } },
  },
];

const templateSystem = 'template-system';

runner
  .test('OpenAI contract', async () => {
    const provider = new OpenAIProvider('test-key', 'gpt-4o', 'https://api.openai.com');
    expect.toEqual(provider.toConfig().baseUrl, 'https://api.openai.com/v1');

    const originalFetch = globalThis.fetch;
    let capturedBody: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      } as any;
    }) as any;

    try {
      await provider.complete(messages, { system: templateSystem, tools });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect.toBeTruthy(Array.isArray(capturedBody.tools));
    const systemMessages = capturedBody.messages.filter((msg: any) => msg.role === 'system');
    expect.toEqual(systemMessages[0].content, templateSystem);
    expect.toEqual(systemMessages[1].content, 'sys-msg');
    const toolMessage = capturedBody.messages.find((msg: any) => msg.role === 'tool');
    expect.toBeTruthy(toolMessage);
    expect.toEqual(typeof toolMessage.content, 'string');
    expect.toContain(toolMessage.content, '"ok":true');
  })
  .test('Gemini contract', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-3.0-flash', 'http://localhost:9999');
    expect.toEqual(provider.toConfig().baseUrl, 'http://localhost:9999/v1beta');

    const originalFetch = globalThis.fetch;
    let capturedBody: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      } as any;
    }) as any;

    try {
      await provider.complete(messages, { system: templateSystem, tools });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const systemText = capturedBody.systemInstruction?.parts?.[0]?.text ?? '';
    expect.toContain(systemText, templateSystem);
    expect.toContain(systemText, 'sys-msg');
    expect.toBeTruthy(Array.isArray(capturedBody.tools?.[0]?.functionDeclarations));

    const parts = capturedBody.contents?.flatMap((entry: any) => entry.parts || []) || [];
    const responsePart = parts.find((part: any) => part.functionResponse);
    expect.toBeTruthy(responsePart);
    expect.toEqual(typeof responsePart.functionResponse.response.content, 'string');
    expect.toContain(responsePart.functionResponse.response.content, '"ok":true');
  })
  .test('Anthropic contract', async () => {
    const provider = new AnthropicProvider('test-key', 'claude-test', 'https://api.anthropic.com');
    expect.toEqual(provider.toConfig().baseUrl, 'https://api.anthropic.com');

    const originalFetch = globalThis.fetch;
    let capturedBody: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
        }),
      } as any;
    }) as any;

    try {
      await provider.complete(messages, { system: templateSystem, tools });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect.toEqual(capturedBody.system, templateSystem);
    expect.toBeTruthy(Array.isArray(capturedBody.tools));
    expect.toEqual(capturedBody.messages[0].role, 'user');
    const hasSystemText = JSON.stringify(capturedBody.messages[0].content).includes('sys-msg');
    expect.toEqual(hasSystemText, true);
    const allBlocks = capturedBody.messages.flatMap((msg: any) => msg.content || []);
    const toolResultBlock = allBlocks.find((block: any) => block.type === 'tool_result');
    expect.toBeTruthy(toolResultBlock);
  });

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
