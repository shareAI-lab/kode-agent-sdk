import { collectEvents, wait } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';
import { IntegrationHarness } from '../../helpers/integration-harness';

const runner = new TestRunner('集成测试 - Todo 事件流');

runner.test('Todo 多轮更新触发事件', async () => {
  console.log('\n[Todo事件测试] 测试目标:');
  console.log('  1) Todo 增删改会触发 todo_changed');
  console.log('  2) reminder 周期触发 todo_reminder');

  const harness = await IntegrationHarness.create({
    customTemplate: {
      id: 'integration-todo-events',
      systemPrompt: 'You are a todo manager assistant.',
      runtime: {
        todo: { enabled: true, remindIntervalSteps: 1, reminderOnStart: true },
      },
    },
  });

  const agent = harness.getAgent();
  let changeCount = 0;
  const monitorEventsPromise = collectEvents(agent, ['monitor'], (event) => {
    if (event.type === 'todo_changed') {
      changeCount += 1;
    }
    return event.type === 'todo_reminder' && changeCount >= 2;
  });

  await agent.setTodos([
    { id: 'todo-1', title: '第一项任务', status: 'pending' },
  ]);

  await agent.updateTodo({ id: 'todo-1', title: '第一项任务', status: 'in_progress' });
  await wait(200);
  await harness.chatStep({
    label: 'Todo阶段1',
    prompt: '请确认当前 todo 列表仍有未完成项，并简要回复。',
  });
  await agent.updateTodo({ id: 'todo-1', title: '第一项任务', status: 'completed' });
  await wait(200);
  await agent.deleteTodo('todo-1');

  const events = await monitorEventsPromise as any[];
  const types = events.map((e: any) => e.type);

  expect.toBeTruthy(types.includes('todo_changed'));
  expect.toBeTruthy(types.includes('todo_reminder'));

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
