import { Agent } from '../../../src';
import { TestRunner, expect } from '../../helpers/utils';
import { createMockServer } from '../../helpers/mock-server';
import { createProviderTestAgent } from '../../helpers/provider-harness';
import {
  assertPermissionDecided,
  assertPermissionRequired,
  assertTextStream,
  assertToolDeniedFlow,
  assertToolFailureFlow,
  assertToolSuccessFlow,
  runChatWithEvents,
} from '../../helpers/provider-events';

const runner = new TestRunner('Provider/Anthropic(Mock)');

function anthropicBodyHasText(body: any, text: string): boolean {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some((msg: any) => {
    const content = Array.isArray(msg?.content) ? msg.content : [];
    return content.some((block: any) => block?.type === 'text' && typeof block?.text === 'string' && block.text.includes(text));
  });
}

function anthropicSse(events: any[]): string[] {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
}

function anthropicTextStream(text: string) {
  return anthropicSse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', usage: { input_tokens: 2, output_tokens: 4 } },
    { type: 'message_stop' },
  ]);
}

function anthropicToolCallStream(toolName: string, args: string) {
  return anthropicSse([
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call-1', name: toolName, input: {} },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]);
}

runner
  .test('正常输出（流式）', async () => {
    const server = await createMockServer([{ response: { stream: anthropicTextStream('Hello Anthropic') } }]);
    const ctx = await createProviderTestAgent({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-test',
      baseUrl: server.baseUrl,
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'hi');
      assertTextStream(result.progress, 'anthropic:normal');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('工具发现（请求包含 tools）', async () => {
    const server = await createMockServer([
      {
        assert: (req) => {
          expect.toBeTruthy(req.body?.tools?.length > 0, 'tools should be present');
        },
        response: { stream: anthropicTextStream('Tool discovery ok') },
      },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-test',
      baseUrl: server.baseUrl,
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'hello');
      assertTextStream(result.progress, 'anthropic:tools');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('工具调用成功', async () => {
    const server = await createMockServer([
      { response: { stream: anthropicToolCallStream('always_ok', '{"value":"ping"}') } },
      { response: { stream: anthropicTextStream('Tool ok') } },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-test',
      baseUrl: server.baseUrl,
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'Please call always_ok.');
      assertToolSuccessFlow(result.progress, 'anthropic:tool-success');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('工具调用失败', async () => {
    const server = await createMockServer([
      { response: { stream: anthropicToolCallStream('always_fail', '{"reason":"forced"}') } },
      { response: { stream: anthropicTextStream('Tool failed') } },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-test',
      baseUrl: server.baseUrl,
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'Please call always_fail.');
      assertToolFailureFlow(result.progress, 'anthropic:tool-fail');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('多轮交互', async () => {
    const server = await createMockServer([
      { response: { stream: anthropicTextStream('Round one') } },
      {
        assert: (req) => {
          expect.toBeTruthy(anthropicBodyHasText(req.body, 'First round'), 'history should include first round');
        },
        response: { stream: anthropicTextStream('Round two') },
      },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-test',
      baseUrl: server.baseUrl,
    });

    try {
      const round1 = await runChatWithEvents(ctx.agent, 'First round');
      assertTextStream(round1.progress, 'anthropic:round1');
      const round2 = await runChatWithEvents(ctx.agent, 'Second round');
      assertTextStream(round2.progress, 'anthropic:round2');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('权限请求（approval -> allow）', async () => {
    const server = await createMockServer([
      { response: { stream: anthropicToolCallStream('always_ok', '{"value":"ping"}') } },
      { response: { stream: anthropicTextStream('Approved') } },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-test',
      baseUrl: server.baseUrl,
      permission: { mode: 'approval' },
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'Call always_ok with approval.', {
        onPermission: async (event) => {
          await event.respond('allow');
        },
      });
      assertPermissionRequired(result.control, 'anthropic:permission');
      assertToolSuccessFlow(result.progress, 'anthropic:permission');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('权限请求（approval -> deny）', async () => {
    const server = await createMockServer([
      { response: { stream: anthropicToolCallStream('always_ok', '{"value":"ping"}') } },
      { response: { stream: anthropicTextStream('Denied') } },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-test',
      baseUrl: server.baseUrl,
      permission: { mode: 'approval' },
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'Call always_ok with approval.', {
        onPermission: async (event) => {
          await event.respond('deny');
        },
      });
      assertPermissionRequired(result.control, 'anthropic:permission-deny');
      assertPermissionDecided(result.control, 'deny', 'anthropic:permission-deny');
      assertToolDeniedFlow(result.progress, 'anthropic:permission-deny');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('resume 后继续对话', async () => {
    const server = await createMockServer([
      { response: { stream: anthropicTextStream('Before resume') } },
      {
        assert: (req) => {
          expect.toBeTruthy(anthropicBodyHasText(req.body, 'resume-one'), 'history should include resume-one');
        },
        response: { stream: anthropicTextStream('After resume') },
      },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-test',
      baseUrl: server.baseUrl,
    });

    try {
      const first = await runChatWithEvents(ctx.agent, 'resume-one');
      assertTextStream(first.progress, 'anthropic:resume-1');

      const resumed = await Agent.resume(ctx.agent.agentId, ctx.config, ctx.deps);
      const second = await runChatWithEvents(resumed, 'resume-two');
      assertTextStream(second.progress, 'anthropic:resume-2');
    } finally {
      await ctx.cleanup();
      await server.close();
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
