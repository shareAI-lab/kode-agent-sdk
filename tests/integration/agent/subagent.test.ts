import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { TestRunner, expect } from '../../helpers/utils';
import { IntegrationHarness } from '../../helpers/integration-harness';
import { collectEvents } from '../../helpers/setup';
import { tool, EnhancedToolContext } from '../../../src/tools/tool';
import { AgentTemplate, createTaskRunTool } from '../../../src/tools/task_run';
import { ContentBlock } from '../../../src/core/types';
import { ModelResponse } from '../../../src/infra/provider';

const runner = new TestRunner('集成测试 - 子 Agent 委派');

runner.test('task_run 协调多子代理并结合 todo / 权限 / Hook', async () => {
  console.log('\n[子代理综合测试] 测试目标:');
  console.log('  1) 父代理通过 task_run 协调多个子代理完成计划与文件修改');
  console.log('  2) 权限审批、Todo 生命周期、Monitor 事件与 Hook 全程生效');
  console.log('  3) 子代理结果与自定义工具事件在 Resume 之前保持一致');

  const hookCounters = { pre: 0, post: 0, messagesChanged: 0 };
  const toolCounters = { pre: 0, post: 0 };
  const notedStages: string[] = [];
  let currentStage = '阶段1-规划';

  const probeTool = tool({
    name: 'coordination_probe',
    description: 'Emit monitor events for coordination tracing.',
    parameters: z.object({ stage: z.string() }),
    async execute(args: { stage: string }, ctx: EnhancedToolContext) {
      notedStages.push(args.stage);
      ctx.emit('coordination_probe', { stage: args.stage });
      return { ok: true, stage: args.stage };
    },
    hooks: {
      preToolUse: async () => {
        toolCounters.pre += 1;
        console.log(`[子代理测试][Hook] preToolUse (${currentStage})`);
      },
      postToolUse: async (outcome) => {
        toolCounters.post += 1;
        console.log(`[子代理测试][Hook] postToolUse (${currentStage})`);
        return { replace: outcome };
      },
    },
  });

  const subTemplates: AgentTemplate[] = [
    {
      id: 'sub-analyzer',
      system: 'You analyse requirements and maintain todos accordingly.',
      tools: ['todo_write', 'todo_read'],
      whenToUse: 'Explain todo updates and next actions.',
    },
    {
      id: 'sub-editor',
      system: 'You update files precisely and confirm the result using fs_read.',
      tools: ['fs_write', 'fs_read'],
      whenToUse: 'Modify project files after approval.',
    },
  ];

  const taskRunTool = createTaskRunTool(subTemplates);

  const parentTemplate = {
    id: 'integration-task-orchestrator',
    systemPrompt: [
      'You orchestrate sub-agents to plan and execute updates.',
      'Call coordination_probe exactly once per user request before replying, but do not call it again when responding to tool_result or system-reminder messages.',
      'Use todo_* tools to mirror progress and rely on sub-agents for specialised work.',
    ].join('\n'),
    tools: ['coordination_probe', 'task_run', 'todo_write', 'todo_read', 'fs_write', 'fs_read'],
    runtime: {
      todo: { enabled: true, remindIntervalSteps: 1, reminderOnStart: true },
    },
    permission: { mode: 'approval', requireApprovalTools: ['fs_write'] as const },
    hooks: {
      preModel: async () => {
        hookCounters.pre += 1;
        console.log(`[子代理测试][Hook] preModel (${currentStage})`);
      },
      postModel: async (response: ModelResponse) => {
        hookCounters.post += 1;
        console.log(`[子代理测试][Hook] postModel (${currentStage})`);
        const block = (response.content as ContentBlock[] | undefined)?.find(
          (entry): entry is Extract<ContentBlock, { type: 'text' }> => entry.type === 'text'
        );
        if (block) {
          block.text = `${block.text}\n【阶段: ${currentStage}】`;
        }
      },
      messagesChanged: async (snapshot: { messages?: Array<{ role: string }> }) => {
        hookCounters.messagesChanged += 1;
        console.log(
          `[子代理测试][Hook] messagesChanged (${currentStage}) - 消息数: ${snapshot?.messages?.length ?? 0}`
        );
      },
    },
  };

  const harness = await IntegrationHarness.create({
    customTemplate: parentTemplate,
    registerTools: (registry) => {
      registry.register(probeTool.name, () => probeTool);
      registry.register(taskRunTool.name, () => taskRunTool);
    },
    registerTemplates: (registry) => {
      for (const tpl of subTemplates) {
        registry.register({
          id: tpl.id,
          systemPrompt: tpl.system ?? 'You are a reliable sub-agent.',
          tools: tpl.tools,
        });
      }
    },
  });

  const agent = harness.getAgent();
  const workDir = harness.getWorkDir();
  expect.toBeTruthy(workDir);
  const targetFile = path.join(workDir!, 'task-run-composite.txt');
  fs.writeFileSync(targetFile, '初始占位内容');

  // 阶段 1：规划并创建 Todo
  currentStage = '阶段1-规划';
  const stage1 = await harness.chatStep({
    label: '阶段1',
    prompt:
      '请先调用 coordination_probe，且 stage 参数必须是“阶段1-规划”。' +
      '你的回复中必须原样包含“阶段1”。随后委派分析子代理总结“更新task-run测试”要点，并创建一条 ResumeTask 的 todo。',
    expectation: {
      includes: ['阶段1', 'ResumeTask'],
    },
  });

  expect.toBeTruthy(stage1.reply.text?.includes('阶段1'));
  const todosAfterStage1 = agent.getTodos();
  expect.toEqual(todosAfterStage1.length, 1);
  expect.toEqual(todosAfterStage1[0].title.includes('ResumeTask'), true);

  const monitorEventsPhase1 = stage1.events.filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'tool_custom_event'
  );
  expect.toBeGreaterThanOrEqual(monitorEventsPhase1.length, 1);

  // 阶段 2：编辑文件触发审批
  currentStage = '阶段2-编辑';
  const permissionRequired = collectEvents(agent, ['control'], (event) => event.type === 'permission_required');

  const stage2 = await harness.chatStep({
    label: '阶段2',
    prompt:
      '请先调用 coordination_probe，且 stage 参数必须是“阶段2-编辑”。随后委派子代理将 task-run-composite.txt 内容改写为“子代理已成功更新”。' +
      '确保获取审批后继续，并将 todo 状态标记为 in_progress。',
  });

  const controlEvents = await permissionRequired;
  expect.toBeGreaterThanOrEqual(controlEvents.length, 1);
  expect.toBeGreaterThanOrEqual(
    stage2.events.filter((evt) => evt.channel === 'control' && evt.event.type === 'permission_decided').length,
    1
  );
  const monitorEventsStage2 = stage2.events.filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'tool_custom_event'
  );
  expect.toBeGreaterThanOrEqual(monitorEventsStage2.length, 1);

  const fileContent = fs.readFileSync(targetFile, 'utf-8');
  expect.toContain(fileContent, '子代理已成功更新');

  const todosAfterStage2 = agent.getTodos();
  expect.toEqual(todosAfterStage2[0].status === 'in_progress' || todosAfterStage2[0].status === 'completed', true);

  // 阶段 3：完成 todo 并由子代理总结
  currentStage = '阶段3-总结';
  const stage3 = await harness.chatStep({
    label: '阶段3',
    prompt:
      '请先调用 coordination_probe，且 stage 参数必须是“阶段3-总结”。随后将 todo 标记为完成，并委派分析子代理总结整个流程。',
    expectation: {
      includes: ['阶段3', '完成'],
    },
  });

  const todosAfterStage3 = agent.getTodos();
  expect.toEqual(todosAfterStage3[0].status, 'completed');

  const monitorEventsStage3 = stage3.events.filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'tool_custom_event'
  );
  expect.toBeGreaterThanOrEqual(monitorEventsStage3.length, 1);

  const summary = await harness.delegateTask({
    label: '阶段3-外部总结',
    templateId: 'sub-analyzer',
    prompt: '请确认 todo 已完成，并引用“子代理已成功更新”这句话。',
    tools: ['todo_read'],
  });
  expect.toEqual(summary.status, 'ok');
  expect.toBeTruthy(summary.text && summary.text.includes('子代理已成功更新'));

  expect.toBeGreaterThanOrEqual(hookCounters.pre, 3);
  expect.toBeGreaterThanOrEqual(hookCounters.post, 3);
  expect.toBeGreaterThanOrEqual(hookCounters.messagesChanged, 3);
  expect.toBeGreaterThanOrEqual(toolCounters.pre, 3);
  expect.toBeGreaterThanOrEqual(toolCounters.post, 3);

  expect.toBeTruthy(notedStages.some((stage) => stage.includes('阶段1')));
  expect.toBeTruthy(notedStages.some((stage) => stage.includes('阶段2')));
  expect.toBeTruthy(notedStages.some((stage) => stage.includes('阶段3')));

  await (agent as any).sandbox?.dispose?.();
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
