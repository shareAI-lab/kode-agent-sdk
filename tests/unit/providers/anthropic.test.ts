import { AnthropicProvider } from '../../../src/infra/provider';
import { Message } from '../../../src/core/types';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('Provider/Anthropic');

runner.test('system message 降级为 user 且 system 参数透传', async () => {
  const provider = new AnthropicProvider('test-key', 'claude-test', 'https://api.anthropic.com');
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
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: 'end_turn',
      }),
    } as any;
  }) as any;

  try {
    await provider.complete(messages, { system: 'template-system' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect.toEqual(capturedBody.system, 'template-system');
  expect.toEqual(capturedBody.messages[0].role, 'user');
  expect.toContain(JSON.stringify(capturedBody.messages[0].content), 'sys-msg');
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
