import fs from 'fs';
import path from 'path';
import { collectEvents, wait } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';
import { IntegrationHarness } from '../../helpers/integration-harness';

const runner = new TestRunner('集成测试 - 权限审批');

runner.test('审批后工具继续执行', async () => {
  console.log('\n[权限测试] 测试目标:');
  console.log('  1) 权限模式要求 todo_write 审批');
  console.log('  2) 控制通道产生 permission_required / permission_decided');
  console.log('  3) 审批通过后 todo 实际写入并 persisted');

  const workDir = path.join(__dirname, '../../tmp/integration-permissions');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const customTemplate = {
    id: 'integration-permission',
    systemPrompt: `You are a precise assistant. When the user asks to create a todo, always call the todo_write tool with the provided title and mark it pending. Do not respond with natural language until the todo is created.`,
    tools: ['todo_write', 'todo_read'],
    permission: { mode: 'approval', requireApprovalTools: ['todo_write'] as const },
    runtime: {
      todo: { enabled: true, remindIntervalSteps: 2, reminderOnStart: false },
    },
  };

  const harness = await IntegrationHarness.create({
    customTemplate,
    workDir,
  });

  const agent = harness.getAgent();

  const controlEventsPromise = collectEvents(agent, ['control'], (event) => event.type === 'permission_decided');

  const { reply, events } = await harness.chatStep({
    label: '权限阶段',
    prompt: '请建立一个标题为「审批集成测试」的待办，并等待批准。',
  });
  expect.toEqual(reply.status, 'ok');

  const controlEvents = (await controlEventsPromise) as any[];
  expect.toBeGreaterThanOrEqual(controlEvents.length, 1);
  expect.toBeGreaterThanOrEqual(
    events.filter((evt) => evt.channel === 'control' && evt.event.type === 'permission_required').length,
    1
  );
  expect.toBeGreaterThanOrEqual(
    events.filter((evt) => evt.channel === 'control' && evt.event.type === 'permission_decided').length,
    1
  );

  await wait(1500);

  const todos = agent.getTodos();
  expect.toEqual(todos.length, 1);
  expect.toEqual(todos[0].title.includes('审批集成测试'), true);

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
