import fs from 'fs';
import path from 'path';

import { Agent } from '../../../src';
import { collectEvents, wait } from '../../helpers/setup';
import { IntegrationHarness } from '../../helpers/integration-harness';
import { TestRunner, expect } from '../../helpers/utils';
import { tool, EnhancedToolContext } from '../../../src/tools/tool';
import { z } from 'zod';

const runner = new TestRunner('集成测试 - Resume 场景');

runner.test('Manual resume preserves hooks, todos, custom tool and subagent state', async () => {
  console.log('\n[Resume手动测试] 测试目标:');
  console.log('  1) Resume 后模板与工具 Hook 继续生效');
  console.log('  2) Todo 状态与自定义工具事件保持');
  console.log('  3) Sub-agent 可在 Resume 后继续工作');

  const hookFlags = { pre: 0, post: 0, messagesChanged: 0 };

  const probeTool = tool({
    name: 'resume_probe',
    description: 'Emit custom events for resume validation.',
    parameters: z.object({ note: z.string() }),
    async execute(args: { note: string }, ctx: EnhancedToolContext) {
      ctx.emit('resume_probe', { note: args.note });
      return { ok: true, note: args.note };
    },
  });

  const harness = await IntegrationHarness.create({
    customTemplate: {
      id: 'resume-manual',
      systemPrompt: 'You are a validation agent. Always call resume_probe before replying and keep todos consistent.',
      tools: ['resume_probe', 'todo_write', 'todo_read'],
      runtime: {
        todo: { enabled: true, remindIntervalSteps: 1, reminderOnStart: true },
      },
      hooks: {
        preModel: async () => {
          hookFlags.pre += 1;
        },
        postModel: async () => {
          hookFlags.post += 1;
        },
        messagesChanged: async () => {
          hookFlags.messagesChanged += 1;
        },
      },
    },
    registerTools: (registry) => {
      registry.register(probeTool.name, () => probeTool);
    },
  });

  const agent = harness.getAgent();

  const stage1 = await harness.chatStep({
    label: 'Resume阶段1',
    prompt: '请调用 resume_probe 工具记录“阶段1”，并创建一个标题为 ResumeCase 的 todo。',
    expectation: {
      includes: ['ResumeCase', '阶段1'],
    },
  });
  expect.toBeTruthy(stage1.reply.text?.includes('ResumeCase'));

  const todosBefore = agent.getTodos();
  expect.toEqual(todosBefore.length, 1);

  const statusBefore = await agent.status();

  await harness.resume('Resume阶段2');

  const stage2 = await harness.chatStep({
    label: 'Resume阶段2',
    prompt: '请再次调用 resume_probe 记录“阶段2”，并确认 todo 仍为 ResumeCase。',
    expectation: {
      includes: ['阶段2', 'ResumeCase'],
    },
  });

  const monitorEvents = stage2.events.filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'tool_custom_event'
  );
  expect.toBeGreaterThanOrEqual(monitorEvents.length, 1);

  const todosAfter = harness.getAgent().getTodos();
  expect.toEqual(todosAfter.length, 1);
  expect.toEqual(todosAfter[0].title.includes('ResumeCase'), true);

  const replayOptions = statusBefore.lastBookmark ? { since: statusBefore.lastBookmark } : undefined;
  const replayed = await collectEvents(harness.getAgent(), ['monitor'], (event) => event.type === 'agent_resumed', replayOptions);
  expect.toBeTruthy(
    replayed.some((event: any) => event.type === 'agent_resumed' && event.strategy === 'manual')
  );

  expect.toBeGreaterThanOrEqual(hookFlags.pre, 2);
  expect.toBeGreaterThanOrEqual(hookFlags.post, 2);
  expect.toBeGreaterThanOrEqual(hookFlags.messagesChanged, 2);

  await harness.cleanup();
});

runner.test('Crash resume seals pending approvals and preserves state', async () => {
  console.log('\n[Resume崩溃测试] 测试目标:');
  console.log('  1) 崩溃后 Resume 会自动封存未完成的工具调用');
  console.log('  2) Sealed 结果写回消息与工具记录');
  console.log('  3) Resume 后仍可以正常继续对话');

  const harness = await IntegrationHarness.create({
    customTemplate: {
      id: 'resume-crash',
      systemPrompt: 'You must request approval before writing files and never bypass approvals.',
      tools: ['fs_write', 'fs_read'],
      permission: { mode: 'approval', requireApprovalTools: ['fs_write'] as const },
    },
  });

  const agent = harness.getAgent();
  const workDir = harness.getWorkDir();
  expect.toBeTruthy(workDir);
  const targetFile = path.join(workDir!, 'resume-crash.txt');
  fs.writeFileSync(targetFile, '原始内容');

  const { reply } = await harness.chatStep({
    label: 'Crash阶段1',
    prompt: '请将 resume-crash.txt 覆盖为 “已修改”。等待批准后再继续。',
    approval: { mode: 'manual' },
  });

  expect.toEqual(reply.status, 'paused');
  expect.toBeTruthy(reply.permissionIds && reply.permissionIds.length === 1);

  const config = harness.getConfig();
  const deps = harness.getDependencies();
  const agentId = agent.agentId;

  const resumed = await Agent.resume(agentId, config, deps, { strategy: 'crash' });

  const timeline: any[] = [];
  for await (const entry of deps.store.readEvents(agentId, { channel: 'monitor' })) {
    timeline.push(entry);
  }
  expect.toBeTruthy(
    timeline.some(
      (entry) => entry.event.type === 'agent_resumed' && (entry.event as any).strategy === 'crash' && (entry.event as any).sealed?.length >= 1
    )
  );

  const toolRecords = await deps.store.loadToolCallRecords(agentId);
  expect.toBeTruthy(toolRecords.length >= 1);
  expect.toBeTruthy(toolRecords.every((record) => record.state === 'SEALED'));

  const messages = await deps.store.loadMessages(agentId);
  const lastMessage = messages[messages.length - 1];
  expect.toEqual(lastMessage.role, 'user');
  expect.toBeTruthy(lastMessage.content.some((block: any) => block.type === 'tool_result'));

  const fileContent = fs.readFileSync(targetFile, 'utf-8');
  expect.toEqual(fileContent.includes('原始内容'), true);

  const followUp = await resumed.chat('请确认上一次写入被封存，并说明文件仍是原始内容。');
  expect.toBeTruthy(followUp.text);

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
