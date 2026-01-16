import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { TestRunner, expect } from '../../helpers/utils';
import { IntegrationHarness } from '../../helpers/integration-harness';
import { collectEvents, wait } from '../../helpers/setup';
import { tool, EnhancedToolContext } from '../../../src/tools/tool';
import { AgentTemplate, createTaskRunTool } from '../../../src/tools/task_run';
import { ContentBlock, ToolOutcome } from '../../../src/core/types';
import { ModelResponse } from '../../../src/infra/provider';

const runner = new TestRunner('集成测试 - 复合能力流程');

runner.test('Hook + Todo + 审批 + 子代理 + 文件操作', async () => {
  console.log('\n[复合能力测试] 测试目标:');
  console.log('  1) 模板 Hook、工具 Hook 与 todo_runtime 在多阶段会话中协同工作');
  console.log('  2) 审批模式拦截 fs_write，审批通过后继续执行并落盘');
  console.log('  3) 子代理可在主流程中汇总进度，Resume 后仍保持 Hook 与 Todo 状态');

  const templateCounters = {
    pre: 0,
    post: 0,
    messagesChanged: 0,
  };

  const toolCounters = {
    pre: 0,
    post: 0,
  };

  const notedStages: string[] = [];
  let currentStage = '阶段1';

  const hookProbe = tool({
    name: 'hook_probe',
    description: 'Emit detailed monitor events for hook lifecycle validation.',
    parameters: z.object({
      note: z.string(),
    }),
    async execute(args: { note: string }, ctx: EnhancedToolContext) {
      const note = args.note || currentStage;
      notedStages.push(note);
      ctx.emit('hook_probe', { stage: currentStage, note });
      return { ok: true, note };
    },
    hooks: {
      preToolUse: async () => {
        toolCounters.pre += 1;
        console.log(`[复合测试][Hook] preToolUse 触发 (${currentStage})`);
      },
      postToolUse: async (outcome: ToolOutcome) => {
        toolCounters.post += 1;
        console.log(`[复合测试][Hook] postToolUse 触发 (${currentStage})`);
        return { replace: outcome };
      },
    },
  });

  const subAgentSystemPrompt = 'You are a concise reviewer. Summarise the latest progress in two short bullet points.';

  const subAgentTemplate: AgentTemplate = {
    id: 'composite-subagent',
    system: subAgentSystemPrompt,
    tools: ['todo_read'],
    whenToUse: 'Summarise todo status for verification.',
  };

  const taskRunTool = createTaskRunTool([subAgentTemplate]);

  const template = {
    id: 'integration-composite-flow',
    systemPrompt: [
      'You are a compliance-focused assistant executing integration tests.',
      'Before responding to any instruction you MUST call hook_probe with a stage-aware note.',
      'When the user asks to manage todos, always use todo tools. For file edits use fs_write/fs_read only.',
      'Await approvals patiently when mutation tools are blocked.',
    ].join('\n'),
    tools: ['hook_probe', 'todo_write', 'todo_read', 'fs_write', 'fs_read', 'task_run'],
    permission: { mode: 'approval', requireApprovalTools: ['fs_write'] as const },
    runtime: {
      todo: { enabled: true, remindIntervalSteps: 1, reminderOnStart: true },
    },
    hooks: {
      preModel: async () => {
        templateCounters.pre += 1;
        console.log(`[复合测试][Hook] preModel 触发 (${currentStage})`);
      },
      postModel: async (response: ModelResponse) => {
        templateCounters.post += 1;
        console.log(`[复合测试][Hook] postModel 触发 (${currentStage})`);
        const block = (response.content as ContentBlock[] | undefined)?.find(
          (entry): entry is Extract<ContentBlock, { type: 'text' }> => entry.type === 'text'
        );
        if (block) {
          block.text = `${block.text}\n【阶段: ${currentStage}】`;
        }
      },
      messagesChanged: async (snapshot: { messages?: Array<{ role: string }> }) => {
        templateCounters.messagesChanged += 1;
        console.log(
          `[复合测试][Hook] messagesChanged 触发 (${currentStage}) - 历史消息数: ${snapshot?.messages?.length ?? 0}`
        );
      },
    },
  };

  const harness = await IntegrationHarness.create({
    customTemplate: template,
    registerTools: (registry) => {
      registry.register(hookProbe.name, () => hookProbe);
      registry.register(taskRunTool.name, () => taskRunTool);
    },
    registerTemplates: (registry) => {
      registry.register({
        id: subAgentTemplate.id,
        systemPrompt: subAgentSystemPrompt,
        tools: subAgentTemplate.tools,
      });
    },
  });

  const agent = harness.getAgent();
  const workDir = harness.getWorkDir();
  expect.toBeTruthy(workDir, '工作目录未初始化');
  const approvalFile = path.join(workDir!, 'approval-target.txt');
  fs.writeFileSync(approvalFile, '初始内容 - 待覆盖');

  // 阶段 1：创建 Todo 并触发 Hook
  currentStage = '阶段1-初始化';
  const stage1 = await harness.chatStep({
    label: '阶段1',
    prompt:
      '请调用 hook_probe 工具记录“阶段1初始化”，然后创建一个标题为《复合测试任务》的 todo 并告诉我当前 todo 状态。',
    expectation: {
      includes: ['复合测试任务', '阶段1-初始化', '阶段'],
    },
  });

  const todosAfterStage1 = agent.getTodos();
  expect.toEqual(todosAfterStage1.length, 1);
  expect.toEqual(todosAfterStage1[0].title.includes('复合测试任务'), true);

  const monitorEventsStage1 = stage1.events.filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'tool_custom_event'
  );
  expect.toBeGreaterThanOrEqual(monitorEventsStage1.length, 1);

  // 阶段 2：触发审批并修改文件
  currentStage = '阶段2-审批';
  const permissionRequired = collectEvents(agent, ['control'], (event) => event.type === 'permission_required');

  const stage2 = await harness.chatStep({
    label: '阶段2',
    prompt:
      '请在得到许可后，将 approval-target.txt 的内容替换为“审批完成，文件已更新”。使用 fs_write 完成，并保留 todo 状态说明。',
  });

  const permissionEvents = await permissionRequired;
  expect.toBeGreaterThanOrEqual(permissionEvents.length, 1);
  expect.toBeGreaterThanOrEqual(
    stage2.events.filter((evt) => evt.channel === 'control' && evt.event.type === 'permission_decided').length,
    1
  );

  const contentAfterApproval = fs.readFileSync(approvalFile, 'utf-8');
  expect.toContain(contentAfterApproval, '审批完成，文件已更新');

  // 阶段 3：调用子代理汇总
  const subAgentResult = await harness.delegateTask({
    label: '阶段3-子代理',
    templateId: subAgentTemplate.id,
    prompt: '请汇总当前复合测试的todo状态，输出两条要点。保留todo的表述，不要转换含义或表达方式。',
    tools: subAgentTemplate.tools,
  });
  expect.toEqual(subAgentResult.status, 'ok');
  expect.toBeTruthy(subAgentResult.text && subAgentResult.text.includes('todo'));

  // 阶段 4：Resume 后继续对话
  await harness.resume('阶段4');
  currentStage = '阶段4-Resume';

  const stage4 = await harness.chatStep({
    label: '阶段4',
    prompt:
      '请再次调用 hook_probe 工具记录“阶段4Resume确认”，然后报告 todo 是否仍为完成状态，并确认文件更新已生效。',
    expectation: {
      includes: ['阶段4-Resume', '完成状态', '文件'],
    },
  });

  const todosAfterResume = harness.getAgent().getTodos();
  expect.toEqual(todosAfterResume.length, 1);
  expect.toEqual(todosAfterResume[0].status, 'completed');

  const resumeMonitorEvents = stage4.events.filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'tool_custom_event'
  );
  expect.toBeGreaterThanOrEqual(resumeMonitorEvents.length, 1);

  // 阶段 5：再次 Resume，验证事件回放与自定义工具/子代理协作
  const statusBeforeSecondResume = await harness.getAgent().status();
  expect.toBeTruthy(statusBeforeSecondResume.lastBookmark);

  await harness.resume('阶段5');
  currentStage = '阶段5-再Resume';

  const replayOptions = statusBeforeSecondResume.lastBookmark
    ? { since: statusBeforeSecondResume.lastBookmark }
    : undefined;

  const replayPromise = collectEvents(
    harness.getAgent(),
    ['monitor'],
    (event) => event.type === 'tool_custom_event',
    replayOptions
  );

  const stage5 = await harness.chatStep({
    label: '阶段5',
    prompt:
      '请调用 hook_probe 工具记录“阶段5连续验证”，重新打开 todo 并标记为进行中，然后再完成它，并让子代理输出进度回顾。',
    expectation: {
      includes: ['阶段5-再Resume', '进度', '完成'],
    },
  });

  const replayedMonitorEvents = await replayPromise;
  expect.toBeGreaterThanOrEqual(replayedMonitorEvents.length, 1);
  expect.toEqual(
    replayedMonitorEvents.some((event: any) => event.type === 'tool_custom_event'),
    true
  );

  const subAgentAfterSecondResume = await harness.delegateTask({
    label: '阶段5-子代理',
    templateId: subAgentTemplate.id,
    prompt: '请再次总结当前 todo 的最新状态，并说明已经经历过多次 Resume 验证。',
    tools: subAgentTemplate.tools,
  });
  expect.toEqual(subAgentAfterSecondResume.status, 'ok');
  expect.toBeTruthy(subAgentAfterSecondResume.text && subAgentAfterSecondResume.text.includes('Resume'));

  const todosAfterSecondResume = harness.getAgent().getTodos();
  expect.toEqual(todosAfterSecondResume.length, 1);
  expect.toEqual(todosAfterSecondResume[0].status, 'completed');

  const todoEventsStage5 = stage5.events.filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'todo_changed'
  );
  expect.toBeGreaterThanOrEqual(todoEventsStage5.length, 1);

  // 断言 Hook 统计数据
  expect.toBeGreaterThanOrEqual(templateCounters.pre, 5);
  expect.toBeGreaterThanOrEqual(templateCounters.post, 5);
  expect.toBeGreaterThanOrEqual(templateCounters.messagesChanged, 5);
  expect.toBeGreaterThanOrEqual(toolCounters.pre, 5);
  expect.toBeGreaterThanOrEqual(toolCounters.post, 5);

  expect.toBeTruthy(notedStages.some((note) => note.includes('阶段1')));
  expect.toBeTruthy(notedStages.some((note) => note.includes('阶段4')));
  expect.toBeTruthy(notedStages.some((note) => note.includes('阶段5')));

  const monitorEvents = [...stage1.events, ...stage2.events, ...stage4.events, ...stage5.events].filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'tool_custom_event'
  );
  expect.toBeGreaterThanOrEqual(monitorEvents.length, 4);

  await wait(200);
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
