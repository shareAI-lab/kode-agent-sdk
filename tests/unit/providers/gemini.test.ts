import { GeminiProvider } from '../../../src/infra/provider';
import { Message } from '../../../src/core/types';
import { prepareMessagesForResume } from '../../../src/infra/providers/core/fork';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('Provider/Gemini');

async function collectStream(provider: GeminiProvider): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of provider.stream([], { thinking: { budgetTokens: 1024 } })) {
    chunks.push(chunk);
  }
  return chunks;
}

runner
  .test('baseUrl 自动补全 /v1beta', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-3.0-flash', 'http://localhost:9999');
    const config = provider.toConfig();
    expect.toEqual(config.baseUrl, 'http://localhost:9999/v1beta');
  })
  .test('systemInstruction 合并与 schema 清洗', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-3.0-flash', 'http://localhost:9999');
    const messages: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'sys-msg' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ];

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
      await provider.complete(messages, {
        system: 'template-system',
        tools: [
          {
            name: 'always_ok',
            description: 'ok',
            input_schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                value: { type: 'string', additionalProperties: true },
              },
            },
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect.toBeTruthy(capturedBody.systemInstruction?.parts?.[0]?.text);
    expect.toContain(capturedBody.systemInstruction.parts[0].text, 'template-system');
    expect.toContain(capturedBody.systemInstruction.parts[0].text, 'sys-msg');

    const parameters = capturedBody.tools?.[0]?.functionDeclarations?.[0]?.parameters;
    expect.toBeFalsy('additionalProperties' in parameters);
    expect.toBeFalsy('additionalProperties' in (parameters?.properties?.value ?? {}));
  })
  .test('stream emits a closed reasoning block before the answer block', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-2.5-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'thinking', thought: true },
                  { text: 'answer' },
                ],
              },
            },
          ],
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )) as any;

    try {
      const chunks = await collectStream(provider);
      expect.toDeepEqual(chunks, [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'reasoning', reasoning: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'reasoning_delta', text: 'thinking' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'answer' },
        },
        { type: 'content_block_stop', index: 1 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('stream closes a reasoning-only response', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-2.5-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: 'thinking only', thought: true }],
              },
            },
          ],
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )) as any;

    try {
      const chunks = await collectStream(provider);
      expect.toDeepEqual(chunks, [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'reasoning', reasoning: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'reasoning_delta', text: 'thinking only' },
        },
        { type: 'content_block_stop', index: 0 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('stream preserves closed block order for a JSON-array response', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-2.5-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          {
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'thinking', thought: true },
                    { text: 'answer' },
                  ],
                },
              },
            ],
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as any;

    try {
      const chunks = await collectStream(provider);
      expect.toDeepEqual(chunks, [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'reasoning', reasoning: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'reasoning_delta', text: 'thinking' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'answer' },
        },
        { type: 'content_block_stop', index: 1 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('stream parses CRLF SSE frames with multiline data split across network chunks', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-2.5-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const event = {
      candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'answer' }] } }],
    };
    const frame =
      JSON.stringify(event, null, 2)
        .split('\n')
        .map((line) => `data: ${line}\r\n`)
        .join('') + '\r\n';
    const encoded = new TextEncoder().encode(frame);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 17));
        controller.enqueue(encoded.slice(17, 53));
        controller.enqueue(encoded.slice(53));
        controller.close();
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as any;

    try {
      const chunks = await collectStream(provider);
      expect.toDeepEqual(chunks, [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'reasoning', reasoning: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'reasoning_delta', text: 'thinking' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'answer' },
        },
        { type: 'content_block_stop', index: 1 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('stream reports malformed SSE data instead of silently dropping it', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-2.5-pro');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('data: {"candidates":\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as any;

    try {
      await expect.toThrow(async () => {
        await collectStream(provider);
      }, 'Gemini stream parse error in SSE frame 1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('complete keeps native thoughts separate from answer text in text transport', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-2.5-pro', undefined, undefined, {
      reasoningTransport: 'text',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'thinking', thought: true },
                  { text: 'answer' },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as any;

    try {
      const response = await provider.complete([], { thinking: { budgetTokens: 1024 } });
      expect.toDeepEqual(response.content, [
        { type: 'reasoning', reasoning: 'thinking' },
        { type: 'text', text: 'answer' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('complete projects canonical reasoning into provider, text, and omit history', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', reasoning: 'PLAN' },
          { type: 'text', text: 'ANSWER' },
        ],
      },
    ];
    const cases: Array<{ transport: 'provider' | 'text' | 'omit'; expected: any[] }> = [
      {
        transport: 'provider',
        expected: [{ text: 'PLAN', thought: true }, { text: 'ANSWER' }],
      },
      {
        transport: 'text',
        expected: [{ text: '<think>PLAN</think>' }, { text: 'ANSWER' }],
      },
      {
        transport: 'omit',
        expected: [{ text: 'ANSWER' }],
      },
    ];
    const originalFetch = globalThis.fetch;

    try {
      for (const testCase of cases) {
        let capturedBody: any;
        globalThis.fetch = (async (_url: any, init: any) => {
          capturedBody = JSON.parse(init.body);
          return new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }) as any;
        const provider = new GeminiProvider('test-key', 'gemini-2.5-pro', undefined, undefined, {
          reasoningTransport: testCase.transport,
        });
        await provider.complete(messages);
        expect.toDeepEqual(capturedBody.contents[0].parts, testCase.expected);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('stream keeps native thoughts separate from answer text in text transport', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-2.5-pro', undefined, undefined, {
      reasoningTransport: 'text',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'thinking', thought: true },
                  { text: 'answer' },
                ],
              },
            },
          ],
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )) as any;

    try {
      const chunks = await collectStream(provider);
      expect.toDeepEqual(chunks, [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'reasoning', reasoning: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'reasoning_delta', text: 'thinking' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'answer' },
        },
        { type: 'content_block_stop', index: 1 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('stream preserves the original order of mixed Gemini parts', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-2.5-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'thought A', thought: true },
                  { text: 'answer B' },
                  { text: 'thought C', thought: true },
                ],
              },
            },
          ],
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )) as any;

    try {
      const chunks = await collectStream(provider);
      expect.toDeepEqual(chunks, [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'reasoning', reasoning: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'reasoning_delta', text: 'thought A' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'answer B' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'reasoning', reasoning: '' },
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'reasoning_delta', text: 'thought C' },
        },
        { type: 'content_block_stop', index: 2 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('stream keeps cross-event order and Gemini function call identity', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-3-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const originalFetch = globalThis.fetch;
    const events = [
      { candidates: [{ content: { parts: [{ text: 'thought A', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'thought B', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'answer C' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'thought D', thought: true }] } }] },
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { id: 'call-E', name: 'tool_e', args: { value: 1 } },
                  thoughtSignature: 'signature-E',
                },
              ],
            },
          },
        ],
      },
    ];
    globalThis.fetch = (async () =>
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as any;

    try {
      const chunks = await collectStream(provider);
      expect.toDeepEqual(chunks, [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'reasoning', reasoning: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'reasoning_delta', text: 'thought A' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'reasoning_delta', text: 'thought B' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'answer C' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'reasoning', reasoning: '' },
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'reasoning_delta', text: 'thought D' },
        },
        { type: 'content_block_stop', index: 2 },
        {
          type: 'content_block_start',
          index: 3,
          content_block: {
            type: 'tool_use',
            id: 'call-E',
            name: 'tool_e',
            input: {},
            meta: { thought_signature: 'signature-E' },
          },
        },
        {
          type: 'content_block_delta',
          index: 3,
          delta: { type: 'input_json_delta', partial_json: '{"value":1}' },
        },
        { type: 'content_block_stop', index: 3 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('complete preserves Gemini function call IDs and signatures', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-3-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { id: 'call-paris', name: 'weather', args: { city: 'Paris' } },
                    thoughtSignature: 'signature-paris',
                  },
                  {
                    functionCall: { id: 'call-london', name: 'weather', args: { city: 'London' } },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as any;

    try {
      const response = await provider.complete([]);
      expect.toDeepEqual(response.content, [
        {
          type: 'tool_use',
          id: 'call-paris',
          name: 'weather',
          input: { city: 'Paris' },
          meta: { thought_signature: 'signature-paris' },
        },
        {
          type: 'tool_use',
          id: 'call-london',
          name: 'weather',
          input: { city: 'London' },
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('complete returns Gemini function call and response IDs in the next request', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-3-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call-paris',
            name: 'weather',
            input: { city: 'Paris' },
            meta: { thought_signature: 'signature-paris' },
          },
          {
            type: 'tool_use',
            id: 'call-london',
            name: 'weather',
            input: { city: 'London' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-paris', content: { temperature: 18 } },
          { type: 'tool_result', tool_use_id: 'call-london', content: { temperature: 14 } },
        ],
      },
    ];
    const originalFetch = globalThis.fetch;
    let capturedBody: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as any;

    try {
      await provider.complete(messages);
      expect.toDeepEqual(capturedBody.contents, [
        {
          role: 'model',
          parts: [
            {
              functionCall: { id: 'call-paris', name: 'weather', args: { city: 'Paris' } },
              thoughtSignature: 'signature-paris',
            },
            {
              functionCall: { id: 'call-london', name: 'weather', args: { city: 'London' } },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-paris',
                name: 'weather',
                response: { content: '{"temperature":18}' },
              },
            },
            {
              functionResponse: {
                id: 'call-london',
                name: 'weather',
                response: { content: '{"temperature":14}' },
              },
            },
          ],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('complete preserves zero, dynamic, and level thinking configuration', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-thinking');
    const originalFetch = globalThis.fetch;
    const capturedConfigs: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedConfigs.push(JSON.parse(init.body).generationConfig?.thinkingConfig);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as any;

    try {
      await provider.complete([], { thinking: { budgetTokens: 0 } });
      await provider.complete([], { thinking: { budgetTokens: -1 } });
      await provider.complete([], { thinking: { level: 'high' } });
      expect.toDeepEqual(capturedConfigs, [
        { thinkingBudget: 0, includeThoughts: true },
        { thinkingBudget: -1, includeThoughts: true },
        { thinkingLevel: 'HIGH', includeThoughts: true },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('complete preserves signatures on thought, text, and empty text parts', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-3-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'PLAN', thought: true, thoughtSignature: 'signature-thought' },
                  { text: 'ANSWER', thoughtSignature: 'signature-answer' },
                  { text: '', thoughtSignature: 'signature-empty' },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as any;
    const expectedContent: Message['content'] = [
      {
        type: 'reasoning',
        reasoning: 'PLAN',
        meta: { thought_signature: 'signature-thought' },
      },
      {
        type: 'text',
        text: 'ANSWER',
        meta: { thought_signature: 'signature-answer' },
      },
      {
        type: 'text',
        text: '',
        meta: { thought_signature: 'signature-empty' },
      },
    ];

    try {
      const response = await provider.complete([]);
      expect.toDeepEqual(response.content, expectedContent);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('complete returns signed thought, text, and empty text parts in provider history', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-3-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            reasoning: 'PLAN',
            meta: { thought_signature: 'signature-thought' },
          },
          {
            type: 'text',
            text: 'ANSWER',
            meta: { thought_signature: 'signature-answer' },
          },
          {
            type: 'text',
            text: '',
            meta: { thought_signature: 'signature-empty' },
          },
        ],
      },
    ];
    const originalFetch = globalThis.fetch;
    let capturedBody: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as any;

    try {
      await provider.complete(messages);
      expect.toDeepEqual(capturedBody.contents, [
        {
          role: 'model',
          parts: [
            {
              text: 'PLAN',
              thought: true,
              thoughtSignature: 'signature-thought',
            },
            {
              text: 'ANSWER',
              thoughtSignature: 'signature-answer',
            },
            {
              text: '',
              thoughtSignature: 'signature-empty',
            },
          ],
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('stream preserves signed thought, text, and empty text as atomic blocks', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-3-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'PLAN', thought: true, thoughtSignature: 'signature-thought' },
                  { text: 'ANSWER', thoughtSignature: 'signature-answer' },
                  { text: '', thoughtSignature: 'signature-empty' },
                ],
              },
            },
          ],
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )) as any;

    try {
      const chunks = await collectStream(provider);
      expect.toDeepEqual(chunks, [
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'reasoning',
            reasoning: '',
            meta: { thought_signature: 'signature-thought' },
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'reasoning_delta', text: 'PLAN' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'text',
            text: '',
            meta: { thought_signature: 'signature-answer' },
          },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'ANSWER' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: {
            type: 'text',
            text: '',
            meta: { thought_signature: 'signature-empty' },
          },
        },
        { type: 'content_block_stop', index: 2 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('Gemini resume preserves reasoning blocks with normalized signatures', async () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            reasoning: 'signed',
            meta: { thought_signature: 'signature-thought' },
          },
          { type: 'reasoning', reasoning: 'unsigned' },
          {
            type: 'text',
            text: 'answer',
            meta: { thought_signature: 'signature-answer' },
          },
        ],
      },
    ];

    expect.toDeepEqual(prepareMessagesForResume(messages, 'gemini'), [
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            reasoning: 'signed',
            meta: { thought_signature: 'signature-thought' },
          },
          {
            type: 'text',
            text: 'answer',
            meta: { thought_signature: 'signature-answer' },
          },
        ],
      },
    ]);
  })
  .test('stream uses only the first Gemini candidate like complete', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-2.5-pro');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            { content: { parts: [{ text: 'first candidate' }] } },
            { content: { parts: [{ text: 'second candidate' }] } },
          ],
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )) as any;

    try {
      const chunks = await collectStream(provider);
      expect.toDeepEqual(chunks, [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'first candidate' },
        },
        { type: 'content_block_stop', index: 0 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('stream assigns index zero to a tool-only response', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-2.5-pro');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            { content: { parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: {} } }] } },
          ],
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )) as any;

    try {
      const chunks = await collectStream(provider);
      const starts = chunks.filter((chunk) => chunk.type === 'content_block_start');
      expect.toHaveLength(starts, 1);
      expect.toEqual(starts[0].index, 0);
      expect.toEqual(starts[0].content_block.type, 'tool_use');
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('stream marks a synthetic function call ID so it is not returned to Gemini', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-2.5-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'lookup', args: { query: 'x' } } }],
              },
            },
          ],
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )) as any;

    try {
      const chunks = await collectStream(provider);
      const start = chunks.find((chunk) => chunk.type === 'content_block_start');
      expect.toBeTruthy(start?.content_block?.id);
      expect.toDeepEqual(start?.content_block?.meta, {
        gemini_function_call_id_present: false,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  })
  .test('complete does not return a synthetic function call ID to Gemini', async () => {
    const provider = new GeminiProvider('test-key', 'gemini-2.5-pro', undefined, undefined, {
      reasoningTransport: 'provider',
    });
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    let secondBody: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { functionCall: { name: 'lookup', args: { query: 'x' } } },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      secondBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'done' }] } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as any;

    try {
      const first = await provider.complete([]);
      const toolUse = first.content.find(
        (block): block is Extract<(typeof first.content)[number], { type: 'tool_use' }> =>
          block.type === 'tool_use'
      );
      expect.toBeTruthy(toolUse);
      await provider.complete([
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse!.id,
              content: { result: 'ok' },
            },
          ],
        },
      ]);

      const modelCall = secondBody.contents[0].parts[0].functionCall;
      const functionResponse = secondBody.contents[1].parts[0].functionResponse;
      expect.toBeFalsy('id' in modelCall);
      expect.toBeFalsy('id' in functionResponse);
    } finally {
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
