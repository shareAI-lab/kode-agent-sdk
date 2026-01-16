import { collectEvents } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';
import { tool, EnhancedToolContext } from '../../../src/tools/tool';
import fs from 'fs';
import { z } from 'zod';
import { ModelResponse } from '../../../src/infra/provider';
import { ContentBlock, ToolOutcome } from '../../../src/core/types';
import { AgentTemplate, createTaskRunTool } from '../../../src/tools/task_run';
import { IntegrationHarness } from '../../helpers/integration-harness';

const runner = new TestRunner('集成测试 - Hook 机制');

runner.test('模板 Hook 与工具 Hook 生效', async () => {
  console.log('\n[基础Hook测试] 测试目标:');
  console.log('  1) 验证模板 preModel/postModel/messagesChanged 钩子全部触发');
  console.log('  2) 验证工具 pre/post 钩子顺序执行且修改响应');
  console.log('  3) 通过 monitor 事件确认 hook_probe 自定义事件记录');

  const templateFlags = {
    pre: false,
    post: false,
    messagesChanged: 0,
  };

  const toolFlags = {
    pre: false,
    post: false,
  };

  const customTool = tool({
    name: 'hook_probe',
    description: 'Emit custom events to validate hook lifecycle.',
    parameters: z.object({
      note: z.string(),
    }),
    async execute(args: { note: string }, ctx: EnhancedToolContext) {
      ctx.emit?.('hook_probe', { note: args.note });
      return { ok: true, note: args.note };
    },
    hooks: {
      preToolUse: async () => {
        toolFlags.pre = true;
      },
      postToolUse: async (outcome: ToolOutcome) => {
        toolFlags.post = true;
        return { replace: outcome };
      },
    },
  });

  const customTemplate = {
    id: 'integration-hooks',
    systemPrompt: 'You must call hook_probe before replying to any user instruction.',
    hooks: {
      preModel: async () => {
        templateFlags.pre = true;
      },
      postModel: async (response: ModelResponse) => {
        templateFlags.post = true;
        const textBlock = response.content?.find(
          (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text'
        );
        if (textBlock) {
          textBlock.text = `${textBlock.text}\n【来自postModel Hook】`;
        }
      },
      messagesChanged: async (snapshot: { messages?: Array<{ content: ContentBlock[] }> }) => {
        if (snapshot?.messages) {
          templateFlags.messagesChanged += 1;
        }
      },
    },
    tools: ['hook_probe'],
  };

  const harness = await IntegrationHarness.create({
    customTemplate,
    registerTools: (registry) => {
      registry.register(customTool.name, () => customTool);
    },
  });

  const monitorEventsPromise = collectEvents(harness.getAgent(), ['monitor'], (event) => event.type === 'tool_custom_event');

  const { reply } = await harness.chatStep({
    label: '基础Hook测试',
    prompt: '请调用 hook_probe 工具记录“hook 测试成功”，然后说明你做了什么。',
    expectation: {
      includes: ['hook 测试成功', 'Hook'],
    },
  });

  expect.toEqual(templateFlags.pre, true);
  expect.toEqual(templateFlags.post, true);
  expect.toBeGreaterThan(templateFlags.messagesChanged, 0);
  expect.toEqual(toolFlags.pre, true);
  expect.toEqual(toolFlags.post, true);
  expect.toBeTruthy(reply.text && reply.text.includes('【来自postModel Hook】'));

  const events = (await monitorEventsPromise) as any[];
  const customEvent = events.find((event) => event.eventType === 'hook_probe');
  expect.toBeTruthy(customEvent);
  expect.toEqual(customEvent?.data?.note, 'hook 测试成功');

  await harness.cleanup();
});

runner.test('Hook 与工具/Resume/子代理组合流程', async () => {
  console.log('\n[组合Hook测试] 测试目标:');
  console.log('  1) 覆盖模板 Hook 在初始对话与 Resume 后的触发顺序');
  console.log('  2) 验证工具 Hook、task_run 子代理、delegateTask 组合执行');
  console.log('  3) 捕获事件流，确保 progress/monitor/control 记录完整');
  console.log('  4) 验证 hook_probe 自定义事件包含阶段信息，并记录所有 note 数据');

  const hookTimeline: string[] = [];
  const toolTimeline: string[] = [];
  const notedMessages: string[] = [];

  const templateCounters = {
    pre: 0,
    post: 0,
    messagesChanged: 0,
  };

  const toolCounters = {
    pre: 0,
    post: 0,
  };

  let currentStage = '阶段1';

  const customTool = tool({
    name: 'hook_probe',
    description: 'Emit detailed monitor events for hook testing.',
    parameters: z.object({
      note: z.string(),
    }),
    async execute(args: { note: string }, ctx: EnhancedToolContext) {
      const noteValue = args.note || currentStage;
      notedMessages.push(noteValue);
      ctx.emit?.('hook_probe', { note: noteValue, stage: currentStage });
      return { ok: true, note: noteValue };
    },
    hooks: {
      preToolUse: async () => {
        toolCounters.pre += 1;
        toolTimeline.push(`preToolUse:${currentStage}`);
        console.log(`[组合测试][Hook] preToolUse 触发 (${currentStage})`);
      },
      postToolUse: async (outcome: ToolOutcome) => {
        toolCounters.post += 1;
        toolTimeline.push(`postToolUse:${currentStage}`);
        console.log(`[组合测试][Hook] postToolUse 触发 (${currentStage})`);
        return { replace: outcome };
      },
    },
  });

  const subAgentTemplate: AgentTemplate = {
    id: 'hook-sub-agent',
    system: 'You are a concise sub-agent that returns a two-sentence summary in Chinese.',
    tools: ['fs_read'],
    whenToUse: 'Summarise main agent progress for testers.',
  };

  const taskRunTool = createTaskRunTool([subAgentTemplate]);

  const customTemplate = {
    id: 'integration-hooks-composite',
    systemPrompt: [
      'You are a compliance test agent.',
      'Before replying to any user instruction, you MUST call the hook_probe tool with a meaningful note describing the stage.',
      'Prefer using task_run when asked to enlist a helper.',
    ].join('\n'),
    hooks: {
      preModel: async () => {
        templateCounters.pre += 1;
        hookTimeline.push(`preModel:${currentStage}`);
        console.log(`[组合测试][Hook] preModel 触发 (${currentStage})`);
      },
      postModel: async (response: ModelResponse) => {
        templateCounters.post += 1;
        hookTimeline.push(`postModel:${currentStage}`);
        console.log(`[组合测试][Hook] postModel 触发 (${currentStage})`);
        const textBlock = response.content?.find(
          (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text'
        );
        if (textBlock) {
          textBlock.text = `${textBlock.text}\n【Hook:${currentStage}】`;
        }
      },
      messagesChanged: async (snapshot: { messages?: Array<{ role: string; content: ContentBlock[] }> }) => {
        templateCounters.messagesChanged += 1;
        hookTimeline.push(`messagesChanged:${currentStage}`);
        console.log(
          `[组合测试][Hook] messagesChanged 触发 (${currentStage}) - 历史消息数: ${snapshot?.messages?.length ?? 0}`
        );
      },
    },
    tools: ['hook_probe', 'task_run', 'todo_read', 'todo_write'],
  };

  const harness = await IntegrationHarness.create({
    customTemplate,
    registerTools: (registry) => {
      registry.register(customTool.name, () => customTool);
      registry.register(taskRunTool.name, () => taskRunTool);
    },
    registerTemplates: (registry) => {
      registry.register({
        id: subAgentTemplate.id,
        systemPrompt: 'You are a concise assistant that summarises the latest agent progress in two sentences.',
        tools: subAgentTemplate.tools,
      });
    },
  });
  const workDir = harness.getWorkDir();
  expect.toBeTruthy(workDir);

  const firstPrompt = '阶段1: 请先调用 hook_probe 工具记录 "phase-1", 然后用一句话说明你准备如何协助测试。';
  const phase1 = await harness.chatStep({
    label: '阶段1',
    prompt: firstPrompt,
    expectation: {
      includes: ['阶段1', 'Hook:阶段1'],
    },
  });
  expect.toBeTruthy(phase1.reply.text && phase1.reply.text.includes('Hook:阶段1'));

  console.log('\n[阶段1] progress 事件数量:', phase1.events.filter((e) => e.channel === 'progress').length);
  console.log('[阶段1] monitor 事件数量:', phase1.events.filter((e) => e.channel === 'monitor').length);

  const phase1NotePath = `${workDir}/phase1-summary.txt`;
  fs.writeFileSync(phase1NotePath, `阶段1对话摘要:\n${phase1.reply.text || ''}\n`);

  const subTaskResult1 = await harness.delegateTask({
    label: '阶段1-子代理',
    templateId: subAgentTemplate.id,
    prompt: `请先使用 fs_read 读取 ${phase1NotePath}（不要读取目录），然后用两句话总结内容。`,
    tools: subAgentTemplate.tools,
  });
  console.log('[阶段1] 子代理任务结果:', subTaskResult1.text);
  expect.toBeTruthy(subTaskResult1.text);

  currentStage = '阶段2-Resume';

  await harness.resume('阶段2');
  const secondPrompt = '阶段2: 在继续对话前再次调用 hook_probe 记录 "phase-2", 并说明子代理刚刚给出的总结内容。';
  const phase2 = await harness.chatStep({
    label: '阶段2',
    prompt: secondPrompt,
    expectation: {
      includes: ['阶段2', 'Hook:阶段2-Resume'],
    },
  });
  expect.toBeTruthy(phase2.reply.text && phase2.reply.text.includes('Hook:阶段2-Resume'));

  console.log('\n[阶段2] progress 事件数量:', phase2.events.filter((e) => e.channel === 'progress').length);
  console.log('[阶段2] monitor 事件数量:', phase2.events.filter((e) => e.channel === 'monitor').length);

  const phase2NotePath = `${workDir}/phase2-summary.txt`;
  fs.writeFileSync(phase2NotePath, `阶段2对话摘要:\n${phase2.reply.text || ''}\n`);

  const subTaskResult2 = await harness.delegateTask({
    label: '阶段2-子代理',
    templateId: subAgentTemplate.id,
    prompt: `请先使用 fs_read 读取 ${phase2NotePath}（不要读取目录），然后用两句话总结内容并提到阶段2。`,
    tools: subAgentTemplate.tools,
  });
  console.log('[阶段2] 子代理任务结果:', subTaskResult2.text);
  expect.toBeTruthy(subTaskResult2.text);

  console.log('\n[组合测试] Hook 调用轨迹:', hookTimeline);
  console.log('[组合测试] 工具 Hook 轨迹:', toolTimeline);
  console.log('[组合测试] hook_probe 记录内容:', notedMessages);

  expect.toBeGreaterThanOrEqual(templateCounters.pre, 2);
  expect.toBeGreaterThanOrEqual(templateCounters.post, 2);
  expect.toBeGreaterThanOrEqual(templateCounters.messagesChanged, 2);
  expect.toBeGreaterThanOrEqual(toolCounters.pre, 2);
  expect.toBeGreaterThanOrEqual(toolCounters.post, 2);
  expect.toBeTruthy(hookTimeline.includes('preModel:阶段1'));
  expect.toBeTruthy(hookTimeline.includes('preModel:阶段2-Resume'));
  expect.toBeTruthy(hookTimeline.includes('postModel:阶段1'));
  expect.toBeTruthy(hookTimeline.includes('postModel:阶段2-Resume'));
  expect.toBeTruthy(toolTimeline.some((entry) => entry.startsWith('preToolUse:阶段1')));
  expect.toBeTruthy(toolTimeline.some((entry) => entry.startsWith('postToolUse:阶段2-Resume')));
  expect.toBeTruthy(
    notedMessages.some((note) => note.includes('阶段1') || note.includes('phase-1'))
  );
  expect.toBeTruthy(
    notedMessages.some((note) => note.includes('阶段2') || note.includes('phase-2'))
  );

  const phase1ProgressEvents = phase1.events.filter((e) => e.channel === 'progress');
  const phase2ProgressEvents = phase2.events.filter((e) => e.channel === 'progress');
  const monitorCustomEvents = [...phase1.events, ...phase2.events]
    .filter((e) => e.channel === 'monitor' && e.event.type === 'tool_custom_event');

  expect.toBeGreaterThanOrEqual(phase1ProgressEvents.length, 2);
  expect.toBeGreaterThanOrEqual(phase2ProgressEvents.length, 2);
  expect.toBeGreaterThanOrEqual(monitorCustomEvents.length, 2);
  expect.toBeTruthy(
    monitorCustomEvents.some((evt) => evt.event.data?.stage === '阶段1' || evt.event.data?.stage === 'phase-1')
  );
  expect.toBeTruthy(
    monitorCustomEvents.some(
      (evt) => evt.event.data?.stage === '阶段2-Resume' || evt.event.data?.stage === 'phase-2'
    )
  );

  await harness.cleanup();
});

export async function run() {
  return runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
