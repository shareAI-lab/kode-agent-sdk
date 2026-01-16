import { TodoRead } from '../../../src/tools/todo_read';
import { TodoWrite } from '../../../src/tools/todo_write';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('Todo工具');

runner
  .test('todo_read 返回 agent 的 todo 列表', async () => {
    const agent = {
      getTodos: () => [{ id: '1', title: 'Test', status: 'pending', createdAt: Date.now(), updatedAt: Date.now() }],
    };
    const result = await TodoRead.exec({}, { agent } as any);
    expect.toEqual(result.todos.length, 1);
  })

  .test('todo_write 调用 agent.setTodos', async () => {
    const received: any[] = [];
    const agent = {
      setTodos: async (todos: any[]) => {
        received.push(...todos);
      },
    };

    const payload = {
      todos: [{ id: '1', title: 'Done', status: 'completed' }],
    };

    const result = await TodoWrite.exec(payload, { agent } as any);
    expect.toEqual(result.ok, true);
    expect.toEqual(received.length, 1);
  })

  .test('todo_write 限制 in_progress 数量', async () => {
    const agent = {
      setTodos: async () => {},
    };

    const result = await TodoWrite.exec({
      todos: [
        { id: '1', title: 'A', status: 'in_progress' },
        { id: '2', title: 'B', status: 'in_progress' },
      ],
    }, { agent } as any);

    expect.toEqual(result.ok, false);
    expect.toEqual(result._thrownError, true);
    expect.toContain(result.error, 'in_progress');
  });

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
