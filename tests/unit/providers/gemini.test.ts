import { GeminiProvider } from '../../../src/infra/provider';
import { Message } from '../../../src/core/types';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('Provider/Gemini');

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
