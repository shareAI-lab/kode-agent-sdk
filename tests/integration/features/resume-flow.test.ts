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
      systemPrompt:
        'You are a validation agent. Call resume_probe exactly once per user request before replying, ' +
        'but do not call it again when responding to tool_result or system-reminder messages. ' +
        'Keep todos consistent.',
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
    prompt:
      '请调用 resume_probe 工具记录“阶段1”，并创建一个标题为 ResumeCase 的 todo。' +
      '请在回复中明确包含“阶段1”和“ResumeCase”。',
  });
  const stage1CustomEvents = stage1.events.filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'tool_custom_event'
  );
  expect.toBeGreaterThanOrEqual(stage1CustomEvents.length, 1);
  const stage1TodoEvents = stage1.events.filter(
    (evt) => evt.channel === 'monitor' && evt.event.type === 'todo_changed'
  );
  expect.toBeGreaterThanOrEqual(stage1TodoEvents.length, 1);

  const todosBefore = agent.getTodos();
  expect.toEqual(todosBefore.length, 1);

  const statusBefore = await agent.status();

  const agentBeforeResume = harness.getAgent() as any;
  await harness.resume('Resume阶段2');
  await agentBeforeResume.sandbox?.dispose?.();

  const stage2 = await harness.chatStep({
    label: 'Resume阶段2',
    prompt:
      '请再次调用 resume_probe 记录“阶段2”，并确认 todo 仍为 ResumeCase。' +
      '你的回复中必须原样包含“阶段2”和“ResumeCase”。',
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

  const currentAgent = harness.getAgent() as any;
  await currentAgent.sandbox?.dispose?.();
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
      systemPrompt:
        'When asked to write files, call fs_write directly to trigger system approval. ' +
        'Do not ask for approval in natural language or wait for user confirmation.',
      tools: ['fs_write', 'fs_read'],
      permission: { mode: 'approval', requireApprovalTools: ['fs_write'] as const },
    },
  });

  const agent = harness.getAgent();
  const workDir = harness.getWorkDir();
  expect.toBeTruthy(workDir);
  const targetFile = path.join(workDir!, 'resume-crash.txt');
  fs.writeFileSync(targetFile, '原始内容');

  const crashStage1 = await harness.chatStep({
    label: 'Crash阶段1',
    prompt: '请使用 fs_read 读取 resume-crash.txt。只调用 fs_read，不要写入。',
  });

  const crashStage2 = await harness.chatStep({
    label: 'Crash阶段2',
    prompt:
      '请调用 fs_write 将 resume-crash.txt 覆盖为“已修改”。' +
      '必须实际调用 fs_write 触发系统审批，不要只口头询问；审批由系统处理。',
    approval: { mode: 'manual' },
  });

  const { reply } = crashStage2;
  expect.toEqual(reply.status, 'paused');
  const permissionEvents = crashStage2.events.filter(
    (evt: any) => evt.channel === 'control' && evt.event.type === 'permission_required'
  );
  expect.toBeGreaterThanOrEqual(permissionEvents.length, 1);

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
  const readRecords = toolRecords.filter((record) => record.name === 'fs_read');
  const writeRecords = toolRecords.filter((record) => record.name === 'fs_write');
  expect.toBeGreaterThanOrEqual(readRecords.length, 1);
  expect.toBeGreaterThanOrEqual(writeRecords.length, 1);
  expect.toBeTruthy(readRecords.every((record) => record.state === 'COMPLETED'));
  expect.toBeTruthy(writeRecords.every((record) => record.state === 'SEALED'));
  const firstReadAt = Math.min(...readRecords.map((record) => record.createdAt));
  const firstWriteAt = Math.min(...writeRecords.map((record) => record.createdAt));
  expect.toBeTruthy(firstReadAt < firstWriteAt);

  const messages = await deps.store.loadMessages(agentId);
  const lastMessage = messages[messages.length - 1];
  expect.toEqual(lastMessage.role, 'user');
  expect.toBeTruthy(lastMessage.content.some((block: any) => block.type === 'tool_result'));

  const fileContent = fs.readFileSync(targetFile, 'utf-8');
  expect.toEqual(fileContent.includes('原始内容'), true);

  const handledApprovals = new Set<string>();
  const offApproval = resumed.on('permission_required', async (evt: any) => {
    const callId = evt?.call?.id || evt?.callId || evt?.permissionId;
    if (!callId || handledApprovals.has(callId)) return;
    handledApprovals.add(callId);
    if (typeof evt?.respond === 'function') {
      await evt.respond('allow', { note: 'auto allow in crash resume follow-up' });
      return;
    }
    await resumed.decide(callId, 'allow', 'auto allow in crash resume follow-up');
  });

  const followUp = await resumed.chat('请确认上一次写入被封存，并说明文件仍是原始内容。');
  offApproval();
  expect.toBeTruthy(followUp.text);

  await (resumed as any).sandbox?.dispose?.();
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
