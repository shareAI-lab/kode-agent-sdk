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
  })
  .test('stream 使用连续且不冲突的本地 block index', async () => {
    const provider = new OpenAIProvider('test-key', 'gpt-4o', 'https://api.openai.com/v1');
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"hello","reasoning_content":"think","tool_calls":[{"index":0,"id":"call_1","function":{"name":"sum","arguments":"{\\"value\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}],"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}',
      'data: [DONE]',
      '',
    ].join('\n');

    globalThis.fetch = (async () => {
      return {
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sseBody));
            controller.close();
          },
        }),
      } as any;
    }) as any;

    const chunks: any[] = [];
    try {
      for await (const chunk of provider.stream([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])) {
        chunks.push(chunk);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    const starts = chunks.filter((chunk) => chunk.type === 'content_block_start');
    expect.toHaveLength(starts, 3);
    expect.toDeepEqual(
      starts.map((chunk) => ({ index: chunk.index, type: chunk.content_block.type })),
      [
        { index: 0, type: 'text' },
        { index: 1, type: 'reasoning' },
        { index: 2, type: 'tool_use' },
      ]
    );
    const toolDelta = chunks.find((chunk) => chunk.type === 'content_block_delta' && chunk.delta?.type === 'input_json_delta');
    expect.toEqual(toolDelta?.index, 2);
  });

runner.test('stream usage is preserved when the final SSE event has no choices', async () => {
  const originalFetch = globalThis.fetch;
  const entries = [
    { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 242, completion_tokens: 30, total_tokens: 272 } },
  ];
  globalThis.fetch = (async (_input: any, init: any) => {
    expect.toEqual(JSON.parse(init.body).stream_options.include_usage, true);
    return new Response(entries.map(entry => `data: ${JSON.stringify(entry)}\n\n`).join('') + 'data: [DONE]\n\n');
  }) as typeof fetch;
  try {
    const provider = new OpenAIProvider('offline-placeholder', 'offline', 'http://offline.invalid/v1');
    const usages: any[] = [];
    for await (const chunk of provider.stream([{ role: 'user', content: [{ type: 'text', text: 'usage' }] }])) {
      if (chunk.type === 'message_delta') usages.push(chunk.usage);
    }
    expect.toDeepEqual(usages, [{ input_tokens: 242, output_tokens: 30 }]);
  } finally { globalThis.fetch = originalFetch; }
});

runner.test('closing a provider stream cancels and releases its HTTP body reader', async () => {
  const originalFetch = globalThis.fetch;
  let cancellations = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
    },
    cancel() { cancellations++; },
  }));
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    const provider = new OpenAIProvider('offline-placeholder', 'offline', 'http://offline.invalid/v1');
    for await (const chunk of provider.stream([{ role: 'user', content: [{ type: 'text', text: 'cancel' }] }])) {
      if (chunk.type === 'content_block_delta') break;
    }
    expect.toEqual(cancellations, 1);
    expect.toEqual(response.body!.locked, false);
  } finally { globalThis.fetch = originalFetch; }
});

runner.test('the SSE done marker completes a response without waiting for HTTP EOF', async () => {
  const originalFetch = globalThis.fetch;
  let cancellations = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"finished"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    },
    cancel() { cancellations++; },
  }));
  globalThis.fetch = (async () => response) as typeof fetch;
  const provider = new OpenAIProvider('offline-placeholder', 'offline', 'http://offline.invalid/v1');
  const collect = (async () => {
    const chunks = [];
    for await (const chunk of provider.stream([{ role: 'user', content: [{ type: 'text', text: 'finish' }] }])) chunks.push(chunk);
    return chunks;
  })();
  let timer: NodeJS.Timeout | undefined;
  try {
    const chunks = await Promise.race([collect, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Provider waited for EOF after the SSE done marker')), 500);
    })]);
    expect.toEqual(chunks.filter(chunk => chunk.type === 'content_block_stop').length, 1);
    expect.toEqual(cancellations, 1);
    expect.toEqual(response.body!.locked, false);
  } finally {
    clearTimeout(timer);
    if (!cancellations) controller.close();
    await collect;
    globalThis.fetch = originalFetch;
  }
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
