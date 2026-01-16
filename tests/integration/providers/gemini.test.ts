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

const runner = new TestRunner('Provider/Gemini(Mock)');

function geminiBodyHasText(body: any, text: string): boolean {
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  return contents.some((entry: any) => {
    const parts = Array.isArray(entry?.parts) ? entry.parts : [];
    return parts.some((part: any) => typeof part?.text === 'string' && part.text.includes(text));
  });
}

function geminiSse(events: any[]): string[] {
  const lines = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  lines.push('data: [DONE]\n\n');
  return lines;
}

function geminiTextStream(text: string) {
  return geminiSse([
    {
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 4 },
    },
  ]);
}

function geminiToolCallStream(toolName: string, args: any, signature = 'sig-1') {
  return geminiSse([
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: toolName, args },
                thoughtSignature: signature,
              },
            ],
          },
        },
      ],
    },
  ]);
}

runner
  .test('正常输出（流式）', async () => {
    const server = await createMockServer([{ response: { stream: geminiTextStream('Hello Gemini') } }]);
    const ctx = await createProviderTestAgent({
      provider: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-3.0-flash',
      baseUrl: server.baseUrl,
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'hi');
      assertTextStream(result.progress, 'gemini:normal');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('工具发现（请求包含 tools）', async () => {
    const server = await createMockServer([
      {
        assert: (req) => {
          expect.toBeTruthy(req.body?.tools?.[0]?.functionDeclarations?.length > 0, 'functionDeclarations should be present');
        },
        response: { stream: geminiTextStream('Tool discovery ok') },
      },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-3.0-flash',
      baseUrl: server.baseUrl,
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'hello');
      assertTextStream(result.progress, 'gemini:tools');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('工具调用成功（含 thoughtSignature 传递）', async () => {
    const server = await createMockServer([
      { response: { stream: geminiToolCallStream('always_ok', { value: 'ping' }, 'sig-ok') } },
      {
        assert: (req) => {
          const parts = req.body?.contents?.flatMap((c: any) => c.parts || []) || [];
          const hasSignature = parts.some((part: any) => part.thoughtSignature === 'sig-ok');
          expect.toBeTruthy(hasSignature, 'thoughtSignature should be forwarded');
        },
        response: { stream: geminiTextStream('Tool ok') },
      },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-3.0-flash',
      baseUrl: server.baseUrl,
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'Please call always_ok.');
      assertToolSuccessFlow(result.progress, 'gemini:tool-success');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('工具调用失败', async () => {
    const server = await createMockServer([
      { response: { stream: geminiToolCallStream('always_fail', { reason: 'forced' }, 'sig-fail') } },
      { response: { stream: geminiTextStream('Tool failed') } },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-3.0-flash',
      baseUrl: server.baseUrl,
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'Please call always_fail.');
      assertToolFailureFlow(result.progress, 'gemini:tool-fail');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('多轮交互', async () => {
    const server = await createMockServer([
      { response: { stream: geminiTextStream('Round one') } },
      {
        assert: (req) => {
          expect.toBeTruthy(geminiBodyHasText(req.body, 'First round'), 'history should include first round');
        },
        response: { stream: geminiTextStream('Round two') },
      },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-3.0-flash',
      baseUrl: server.baseUrl,
    });

    try {
      const round1 = await runChatWithEvents(ctx.agent, 'First round');
      assertTextStream(round1.progress, 'gemini:round1');
      const round2 = await runChatWithEvents(ctx.agent, 'Second round');
      assertTextStream(round2.progress, 'gemini:round2');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('权限请求（approval -> allow）', async () => {
    const server = await createMockServer([
      { response: { stream: geminiToolCallStream('always_ok', { value: 'ping' }, 'sig-approve') } },
      { response: { stream: geminiTextStream('Approved') } },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-3.0-flash',
      baseUrl: server.baseUrl,
      permission: { mode: 'approval' },
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'Call always_ok with approval.', {
        onPermission: async (event) => {
          await event.respond('allow');
        },
      });
      assertPermissionRequired(result.control, 'gemini:permission');
      assertToolSuccessFlow(result.progress, 'gemini:permission');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('权限请求（approval -> deny）', async () => {
    const server = await createMockServer([
      { response: { stream: geminiToolCallStream('always_ok', { value: 'ping' }, 'sig-deny') } },
      { response: { stream: geminiTextStream('Denied') } },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-3.0-flash',
      baseUrl: server.baseUrl,
      permission: { mode: 'approval' },
    });

    try {
      const result = await runChatWithEvents(ctx.agent, 'Call always_ok with approval.', {
        onPermission: async (event) => {
          await event.respond('deny');
        },
      });
      assertPermissionRequired(result.control, 'gemini:permission-deny');
      assertPermissionDecided(result.control, 'deny', 'gemini:permission-deny');
      assertToolDeniedFlow(result.progress, 'gemini:permission-deny');
    } finally {
      await ctx.cleanup();
      await server.close();
    }
  })
  .test('resume 后继续对话', async () => {
    const server = await createMockServer([
      { response: { stream: geminiTextStream('Before resume') } },
      {
        assert: (req) => {
          expect.toBeTruthy(geminiBodyHasText(req.body, 'resume-one'), 'history should include resume-one');
        },
        response: { stream: geminiTextStream('After resume') },
      },
    ]);
    const ctx = await createProviderTestAgent({
      provider: 'gemini',
      apiKey: 'test-key',
      model: 'gemini-3.0-flash',
      baseUrl: server.baseUrl,
    });

    try {
      const first = await runChatWithEvents(ctx.agent, 'resume-one');
      assertTextStream(first.progress, 'gemini:resume-1');

      const resumed = await Agent.resume(ctx.agent.agentId, ctx.config, ctx.deps);
      const second = await runChatWithEvents(resumed, 'resume-two');
      assertTextStream(second.progress, 'gemini:resume-2');
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
