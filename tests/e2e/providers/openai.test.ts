import { Agent } from '../../../src';
import { TestRunner, expect } from '../../helpers/utils';
import { createProviderTestAgent } from '../../helpers/provider-harness';
import { assertHasText, assertPermissionRequired, assertTextStream, assertToolFailureFlow, assertToolSuccessFlow, runChatWithEvents } from '../../helpers/provider-events';
import { loadProviderEnv } from '../../helpers/provider-env';

const runner = new TestRunner('Provider/OpenAI(E2E)');
const env = loadProviderEnv('openai');

if (!env.ok || !env.config) {
  runner.skip(`OpenAI E2E 跳过：${env.reason}`);
} else {
  const apiKey = env.config.apiKey;
  const model = env.config.model || 'gpt-4o';
  const baseUrl = env.config.baseUrl;
  const proxyUrl = env.config.proxyUrl;

  runner
    .test('正常输出（流式）', async () => {
      const ctx = await createProviderTestAgent({ provider: 'openai', apiKey, model, baseUrl, proxyUrl, tools: [] });
      try {
        const result = await runChatWithEvents(ctx.agent, '你好');
        assertTextStream(result.progress, 'openai:e2e-normal');
        expect.toEqual(ctx.monitorErrors.length, 0);
      } finally {
        await ctx.cleanup();
      }
    })
    .test('工具发现', async () => {
      const ctx = await createProviderTestAgent({ provider: 'openai', apiKey, model, baseUrl, proxyUrl, tools: ['always_ok'] });
      try {
        const result = await runChatWithEvents(ctx.agent, '请列出当前可用的工具名称。');
        assertHasText(result.progress, 'openai:e2e-tools');
        expect.toEqual(ctx.monitorErrors.length, 0);
      } finally {
        await ctx.cleanup();
      }
    })
    .test('工具调用成功', async () => {
      const ctx = await createProviderTestAgent({ provider: 'openai', apiKey, model, baseUrl, proxyUrl, tools: ['always_ok'] });
      try {
        const result = await runChatWithEvents(ctx.agent, '请调用 always_ok 工具，value=ping。');
        assertToolSuccessFlow(result.progress, 'openai:e2e-tool-success');
        expect.toEqual(ctx.monitorErrors.length, 0);
      } finally {
        await ctx.cleanup();
      }
    })
    .test('工具调用失败', async () => {
      const ctx = await createProviderTestAgent({ provider: 'openai', apiKey, model, baseUrl, proxyUrl });
      try {
        const result = await runChatWithEvents(ctx.agent, '请调用 always_fail 工具，reason=forced。');
        assertToolFailureFlow(result.progress, 'openai:e2e-tool-fail');
        const hasForcedError = ctx.monitorErrors.some((evt) => String(evt.message).includes('forced'));
        expect.toBeTruthy(hasForcedError, '[openai:e2e-tool-fail] Missing monitor error');
      } finally {
        await ctx.cleanup();
      }
    })
    .test('多轮交互', async () => {
      const token = 'CTX-OPENAI-42';
      const ctx = await createProviderTestAgent({ provider: 'openai', apiKey, model, baseUrl, proxyUrl, tools: [] });
      try {
        const round1 = await runChatWithEvents(
          ctx.agent,
          `第一轮：请仅输出 "TOKEN=${token}" 并记住它，除此之外不要输出任何文字。`
        );
        assertTextStream(round1.progress, 'openai:e2e-round1');
        const round2 = await runChatWithEvents(ctx.agent, '第二轮：请原样输出你刚才记住的 TOKEN。');
        assertTextStream(round2.progress, 'openai:e2e-round2');
        const replyText = round2.reply.text || '';
        expect.toContain(replyText, token);
        expect.toEqual(ctx.monitorErrors.length, 0);
      } finally {
        await ctx.cleanup();
      }
    })
    .test('权限请求（approval -> allow）', async () => {
      const ctx = await createProviderTestAgent({
        provider: 'openai',
        apiKey,
        model,
        baseUrl,
        proxyUrl,
        tools: ['always_ok'],
        permission: { mode: 'approval' },
      });
      try {
        const result = await runChatWithEvents(ctx.agent, '请调用 always_ok 工具，需要审批。', {
          onPermission: async (event) => {
            await event.respond('allow');
          },
        });
        assertPermissionRequired(result.control, 'openai:e2e-permission');
        assertToolSuccessFlow(result.progress, 'openai:e2e-permission');
        expect.toEqual(ctx.monitorErrors.length, 0);
      } finally {
        await ctx.cleanup();
      }
    })
    .test('权限请求（approval -> deny）', async () => {
      const ctx = await createProviderTestAgent({
        provider: 'openai',
        apiKey,
        model,
        baseUrl,
        proxyUrl,
        tools: ['always_ok'],
        permission: { mode: 'approval' },
      });
      try {
        const result = await runChatWithEvents(ctx.agent, '请调用 always_ok 工具，但需要审批。', {
          onPermission: async (event) => {
            await event.respond('deny');
          },
        });
        assertPermissionRequired(result.control, 'openai:e2e-permission-deny');
        const types = result.progress.map((event) => event.type);
        expect.toBeTruthy(types.includes('tool:start'), '[openai:e2e-permission-deny] Missing tool:start');
        expect.toBeTruthy(types.includes('tool:end'), '[openai:e2e-permission-deny] Missing tool:end');
        expect.toBeFalsy(types.includes('tool:error'), '[openai:e2e-permission-deny] Unexpected tool:error');
        const endEvent = result.progress.find((event) => event.type === 'tool:end') as any;
        expect.toBeTruthy(endEvent?.call?.isError, '[openai:e2e-permission-deny] tool:end should be error');
        expect.toEqual(ctx.monitorErrors.length, 0);
      } finally {
        await ctx.cleanup();
      }
    })
    .test('resume 后继续对话', async () => {
      const token = 'RESUME-OPENAI-42';
      const ctx = await createProviderTestAgent({ provider: 'openai', apiKey, model, baseUrl, proxyUrl, tools: [] });
      try {
        const first = await runChatWithEvents(
          ctx.agent,
          `请仅输出 "TOKEN=${token}" 并记住它，除此之外不要输出任何文字。`
        );
        assertTextStream(first.progress, 'openai:e2e-resume-1');

        const resumed = await Agent.resume(ctx.agent.agentId, ctx.config, ctx.deps);
        const second = await runChatWithEvents(resumed, '请原样输出你刚才记住的 TOKEN。');
        assertTextStream(second.progress, 'openai:e2e-resume-2');
        const replyText = second.reply.text || '';
        expect.toContain(replyText, token);
        expect.toEqual(ctx.monitorErrors.length, 0);
      } finally {
        await ctx.cleanup();
      }
    });
}

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
