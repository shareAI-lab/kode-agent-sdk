import { OpenAIProvider } from '../../../src/infra/provider';
import { Message } from '../../../src/core/types';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('Provider/OpenAI');

runner
  .test('baseUrl 自动补全 /v1', async () => {
    const provider = new OpenAIProvider('test-key', 'gpt-4o', 'https://api.openai.com');
    const config = provider.toConfig();
    expect.toEqual(config.baseUrl, 'https://api.openai.com/v1');
  })
  .test('请求体包含 system 与工具调用结构', async () => {
    const provider = new OpenAIProvider('test-key', 'gpt-4o', 'https://api.openai.com');
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'sys-msg' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'always_ok', input: { value: 'ping' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: { ok: true } }] },
    ];

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
      await provider.complete(messages, {
        system: 'template-system',
        tools: [
          {
            name: 'always_ok',
            description: 'ok',
            input_schema: { type: 'object', properties: { value: { type: 'string' } } },
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect.toBeTruthy(capturedBody);
    expect.toEqual(capturedBody.messages[0].role, 'system');
    expect.toEqual(capturedBody.messages[0].content, 'template-system');
    expect.toEqual(capturedBody.messages[1].role, 'system');
    expect.toEqual(capturedBody.messages[1].content, 'sys-msg');
    const toolCall = capturedBody.messages.find((msg: any) => msg.role === 'assistant')?.tool_calls?.[0];
    expect.toEqual(toolCall?.function?.name, 'always_ok');
    expect.toBeTruthy(typeof toolCall?.function?.arguments === 'string');
    expect.toBeTruthy(Array.isArray(capturedBody.tools));
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
