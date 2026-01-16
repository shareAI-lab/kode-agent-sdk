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

const runner = new TestRunner('Provider/OpenAI(Mock)');

function openaiBodyHasText(body: any, text: string): boolean {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages.some((msg: any) => typeof msg.content === 'string' && msg.content.includes(text));
}

function openaiSse(events: any[]): string[] {
  const lines = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  lines.push('data: [DONE]\n\n');
  return lines;
}

function openaiTextStream(text: string) {
  return openaiSse([
    { choices: [{ delta: { content: text.slice(0, Math.max(1, Math.floor(text.length / 2))) } }] },
    { choices: [{ delta: { content: text.slice(Math.max(1, Math.floor(text.length / 2))) } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 4 } },
  ]);
}

function openaiToolCallStream(toolName: string, args: string) {
  return openaiSse([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                function: { name: toolName, arguments: args },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
}

runner
  .test('正常输出（流式）', async () => {
    const server = await createMockServer([{ response: { stream: openaiTextStream('Hello OpenAI') } }]);
    const ctx = await createProviderTestAgent({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o',
      baseUrl: `${server.baseUrl}/v1`,
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'hi');
      assertTextStream(result.progress, 'openai:normal');
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
        response: { stream: openaiTextStream('Tool discovery ok') },
      },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o',
      baseUrl: `${server.baseUrl}/v1`,
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'hello');
      assertTextStream(result.progress, 'openai:tools');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('工具调用成功', async () => {
    const server = await createMockServer([
      { response: { stream: openaiToolCallStream('always_ok', '{"value":"ping"}') } },
      { response: { stream: openaiTextStream('Tool ok') } },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o',
      baseUrl: `${server.baseUrl}/v1`,
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'Please call always_ok.');
      assertToolSuccessFlow(result.progress, 'openai:tool-success');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('工具调用失败', async () => {
    const server = await createMockServer([
      { response: { stream: openaiToolCallStream('always_fail', '{"reason":"forced"}') } },
      { response: { stream: openaiTextStream('Tool failed') } },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o',
      baseUrl: `${server.baseUrl}/v1`,
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'Please call always_fail.');
      assertToolFailureFlow(result.progress, 'openai:tool-fail');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('多轮交互', async () => {
    const server = await createMockServer([
      { response: { stream: openaiTextStream('Round one') } },
      {
        assert: (req) => {
          expect.toBeTruthy(openaiBodyHasText(req.body, 'First round'), 'history should include first round');
        },
        response: { stream: openaiTextStream('Round two') },
      },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o',
      baseUrl: `${server.baseUrl}/v1`,
    });

    try {
      const round1 = await runChatWithEvents(ctx.agent, 'First round');
      assertTextStream(round1.progress, 'openai:round1');
      const round2 = await runChatWithEvents(ctx.agent, 'Second round');
      assertTextStream(round2.progress, 'openai:round2');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('权限请求（approval -> allow）', async () => {
    const server = await createMockServer([
      { response: { stream: openaiToolCallStream('always_ok', '{"value":"ping"}') } },
      { response: { stream: openaiTextStream('Approved') } },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o',
      baseUrl: `${server.baseUrl}/v1`,
      permission: { mode: 'approval' },
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'Call always_ok with approval.', {
        onPermission: async (event) => {
          await event.respond('allow');
        },
      });
      assertPermissionRequired(result.control, 'openai:permission');
      assertToolSuccessFlow(result.progress, 'openai:permission');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('权限请求（approval -> deny）', async () => {
    const server = await createMockServer([
      { response: { stream: openaiToolCallStream('always_ok', '{"value":"ping"}') } },
      { response: { stream: openaiTextStream('Denied') } },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o',
      baseUrl: `${server.baseUrl}/v1`,
      permission: { mode: 'approval' },
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'Call always_ok with approval.', {
        onPermission: async (event) => {
          await event.respond('deny');
        },
      });
      assertPermissionRequired(result.control, 'openai:permission-deny');
      assertPermissionDecided(result.control, 'deny', 'openai:permission-deny');
      assertToolDeniedFlow(result.progress, 'openai:permission-deny');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('resume 后继续对话', async () => {
    const server = await createMockServer([
      { response: { stream: openaiTextStream('Before resume') } },
      {
        assert: (req) => {
          expect.toBeTruthy(openaiBodyHasText(req.body, 'resume-one'), 'history should include resume-one');
        },
        response: { stream: openaiTextStream('After resume') },
      },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o',
      baseUrl: `${server.baseUrl}/v1`,
    });

    try {
      const first = await runChatWithEvents(ctx.agent, 'resume-one');
      assertTextStream(first.progress, 'openai:resume-1');

      const resumed = await Agent.resume(ctx.agent.agentId, ctx.config, ctx.deps);
      const second = await runChatWithEvents(resumed, 'resume-two');
      assertTextStream(second.progress, 'openai:resume-2');
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
