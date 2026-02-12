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
  .test('baseUrl 保留已有版本路径 /v4 (GLM coding endpoint)', async () => {
    const provider = new OpenAIProvider('test-key', 'any-model', 'https://open.bigmodel.cn/api/coding/paas/v4');
    const config = provider.toConfig();
    expect.toEqual(config.baseUrl, 'https://open.bigmodel.cn/api/coding/paas/v4');
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
  })
  .test('GLM 使用 reasoning 配置注入 thinking 并回传 reasoning_content', async () => {
    const provider = new OpenAIProvider('test-key', 'glm-test', 'https://api.z.ai/api/paas/v4', undefined, {
      reasoningTransport: 'provider',
      reasoning: {
        fieldName: 'reasoning_content',
        requestParams: { thinking: { type: 'enabled', clear_thinking: false } },
      },
    });
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'reasoning', reasoning: 'step1' }, { type: 'text', text: 'ok' }] },
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
      await provider.complete(messages);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect.toBeTruthy(capturedBody.thinking);
    expect.toEqual(capturedBody.thinking.type, 'enabled');
    expect.toEqual(capturedBody.thinking.clear_thinking, false);
    const assistant = capturedBody.messages.find((msg: any) => msg.role === 'assistant');
    expect.toEqual(assistant?.reasoning_content, 'step1');
  })
  .test('MiniMax 使用 reasoning 配置注入 reasoning_split 并回传 reasoning_details', async () => {
    const provider = new OpenAIProvider('test-key', 'minimax-test', 'https://api.minimax.io/v1', undefined, {
      reasoningTransport: 'provider',
      reasoning: {
        fieldName: 'reasoning_details',
        requestParams: { reasoning_split: true },
      },
    });
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'reasoning', reasoning: 'step1' }, { type: 'text', text: 'ok' }] },
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
      await provider.complete(messages);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect.toEqual(capturedBody.reasoning_split, true);
    const assistant = capturedBody.messages.find((msg: any) => msg.role === 'assistant');
    expect.toEqual(assistant?.reasoning_details?.[0]?.text, 'step1');
  })
  .test('不支持 file 时标记 metadata.transport', async () => {
    const provider = new OpenAIProvider('test-key', 'gpt-4o', 'https://api.openai.com/v1');
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'file', url: 'https://example.com/doc.pdf', mime_type: 'application/pdf' }] },
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      } as any;
    }) as any;

    try {
      await provider.complete(messages);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect.toEqual(messages[0].metadata?.transport, 'text');
  })
  .test('Responses API 配置注入 store 和 previous_response_id', async () => {
    const provider = new OpenAIProvider('test-key', 'gpt-4o', 'https://api.openai.com/v1', undefined, {
      api: 'responses',
      responses: {
        store: true,
        previousResponseId: 'resp_abc123',
        reasoning: { effort: 'high' },
      },
    });
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'file', url: 'https://example.com/doc.pdf', mime_type: 'application/pdf' }] },
    ];

    const originalFetch = globalThis.fetch;
    let capturedBody: any;
    let capturedUrl: string = '';
    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          output: [{ content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
          status: 'completed',
        }),
      } as any;
    }) as any;

    try {
      await provider.complete(messages);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect.toBeTruthy(capturedUrl.includes('/responses'));
    expect.toEqual(capturedBody.store, true);
    expect.toEqual(capturedBody.previous_response_id, 'resp_abc123');
    expect.toEqual(capturedBody.reasoning?.effort, 'high');
  })
  .test('DeepSeek 配置 stripFromHistory 时不包含 reasoning_content', async () => {
    const provider = new OpenAIProvider('test-key', 'deepseek-reasoner', 'https://api.deepseek.com/v1', undefined, {
      reasoningTransport: 'provider',
      reasoning: {
        fieldName: 'reasoning_content',
        stripFromHistory: true,
      },
    });
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'reasoning', reasoning: 'step1' }, { type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
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
      await provider.complete(messages);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const assistant = capturedBody.messages.find((msg: any) => msg.role === 'assistant');
    expect.toEqual(assistant?.reasoning_content, undefined);
    expect.toEqual(assistant?.content, 'ok');
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
