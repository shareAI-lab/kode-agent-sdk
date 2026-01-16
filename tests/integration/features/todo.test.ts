import fs from 'fs';
import path from 'path';
import { TestRunner, expect } from '../../helpers/utils';
import { IntegrationHarness } from '../../helpers/integration-harness';

const runner = new TestRunner('集成测试 - Todo 与 Resume');

runner.test('Todo CRUD 持久化并在 Resume 后可恢复', async () => {
  const customTemplate = {
    id: 'integration-todo',
    systemPrompt: 'You manage todos precisely.',
    runtime: {
      todo: { enabled: true, remindIntervalSteps: 1, reminderOnStart: true },
    },
  };

  const harness = await IntegrationHarness.create({ customTemplate });
  const agent = harness.getAgent();
  const storeDir = harness.getStoreDir();
  if (!storeDir) {
    throw new Error('Store 目录未初始化');
  }

  await agent.setTodos([{ id: 'todo-1', title: '完成集成测试', status: 'pending' }]);
  await agent.updateTodo({ id: 'todo-1', title: '完成集成测试', status: 'in_progress' });
  await agent.updateTodo({ id: 'todo-1', title: '完成集成测试', status: 'completed' });

  expect.toEqual(agent.getTodos().length, 1);

  const snapshotId = await agent.snapshot();
  expect.toBeTruthy(snapshotId);

  const snapshotPath = path.join(storeDir, agent.agentId, 'snapshots', `${snapshotId}.json`);
  expect.toEqual(fs.existsSync(snapshotPath), true);

  await harness.resume('Todo-Resume');
  const resumed = harness.getAgent();
  const todosAfterResume = resumed.getTodos();
  expect.toEqual(todosAfterResume.length, 1);
  expect.toEqual(todosAfterResume[0].status, 'completed');

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
