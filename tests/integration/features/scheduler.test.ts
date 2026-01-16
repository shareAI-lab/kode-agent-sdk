
import fs from 'fs';
import path from 'path';

import { TestRunner, expect } from '../../helpers/utils';
import { IntegrationHarness } from '../../helpers/integration-harness';
import { wait, collectEvents } from '../../helpers/setup';

const runner = new TestRunner('集成测试 - Scheduler 与监控');

runner.test('Scheduler 触发提醒并捕获文件监控事件', async () => {
  console.log('\n[Scheduler测试] 场景目标:');
  console.log('  1) 调度器按步数发送提醒并驱动 reminder 消息');
  console.log('  2) 监听 file_changed 与 todo_reminder 事件');
  console.log('  3) 验证 fs_* 工具写入后事件流一致');

  const harness = await IntegrationHarness.create({
    customTemplate: {
      id: 'scheduler-watch',
      systemPrompt: [
        'You are an operations assistant monitoring repository changes.',
        'Keep todos synchronised with reminders and describe file updates准确.',
      ].join('\n'),
      tools: ['fs_read', 'fs_write', 'fs_edit', 'todo_write', 'todo_read'],
      runtime: {
        todo: { enabled: true, reminderOnStart: true, remindIntervalSteps: 2 },
      },
    },
  });

  const agent = harness.getAgent();
  const workDir = harness.getWorkDir();
  expect.toBeTruthy(workDir);
  const targetFile = path.join(workDir!, 'scheduler-demo.txt');
  fs.writeFileSync(targetFile, '初始内容\n');

  const scheduler = agent.schedule();
  const reminders: string[] = [];
  scheduler.everySteps(2, async ({ stepCount }) => {
    reminders.push(`step-${stepCount}`);
    await agent.send(`系统提醒：请更新状态（步 ${stepCount}）。`, { kind: 'reminder' });
  });

  const todoReminderEvents: any[] = [];
  const fileChangeEvents: any[] = [];
  const unsubscribeTodo = agent.on('todo_reminder', (evt) => {
    todoReminderEvents.push(evt);
  });
  const unsubscribeFile = agent.on('file_changed', (evt) => {
    fileChangeEvents.push(evt);
  });

  const stage1 = await harness.chatStep({
    label: 'Scheduler阶段1',
    prompt: '请创建一个标题为“监控演示”的 todo 并列出当前监控计划。',
    expectation: {
      includes: ['监控演示'],
    },
  });
  expect.toBeGreaterThanOrEqual(stage1.events.filter((evt) => evt.channel === 'monitor').length, 1);

  const todosAfterStage1 = agent.getTodos();
  expect.toBeTruthy(todosAfterStage1.some((todo) => todo.title.includes('监控演示')));

  fs.writeFileSync(targetFile, '已修改的内容\n');
  await wait(2000);

  const stage2 = await harness.chatStep({
    label: 'Scheduler阶段2',
    prompt: '请读取 scheduler-demo.txt 并确认内容已经修改，同时更新 todo 状态为进行中。',
    expectation: {
      includes: ['进行中', 'scheduler-demo.txt'],
    },
  });
  expect.toBeGreaterThanOrEqual(stage2.events.filter((evt) => evt.channel === 'progress').length, 1);

  const todosAfterStage2 = agent.getTodos();
  expect.toBeTruthy(todosAfterStage2.some((todo) => todo.status === 'in_progress'));

  fs.appendFileSync(targetFile, '追加一行\n');
  await wait(2000);

  const progressEvents = collectEvents(agent, ['progress'], (event) => event.type === 'done');
  await harness.chatStep({
    label: 'Scheduler阶段3',
    prompt: '请确认你仍在监控并输出一句简短确认。',
  });
  expect.toBeGreaterThanOrEqual((await progressEvents).length, 1);

  scheduler.clear();
  unsubscribeTodo();
  unsubscribeFile();

  expect.toBeGreaterThanOrEqual(reminders.length, 1);
  expect.toBeGreaterThanOrEqual(todoReminderEvents.length, 1);
  expect.toBeGreaterThanOrEqual(fileChangeEvents.length, 1);

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
