/**
 * Agent核心功能单元测试
 */

import { Agent } from '../../../src/core/agent';
import { createUnitTestAgent } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';
import { ContentBlock } from '../../../src/core/types';
import { Hooks } from '../../../src/core/hooks';
import { ModelResponse } from '../../../src/infra/provider';

const runner = new TestRunner('Agent核心功能');

runner
  .test('创建Agent并获取状态', async () => {
    const { agent, cleanup } = await createUnitTestAgent();

    const status = await agent.status();
    expect.toEqual(status.state, 'READY');
    expect.toEqual(status.stepCount, 0);

    await cleanup();
  })

  .test('单轮对话', async () => {
    const { agent, cleanup } = await createUnitTestAgent({
      mockResponses: ['Hello World'],
    });

    const result = await agent.chat('Hi');

    expect.toEqual(result.status, 'ok');
    expect.toBeTruthy(result.text);
    expect.toContain(result.text!, 'Hello World');

    const status = await agent.status();
    expect.toBeGreaterThan(status.stepCount, 0);

    await cleanup();
  })

  .test('多轮对话保持上下文', async () => {
    const { agent, cleanup } = await createUnitTestAgent({
      mockResponses: ['First', 'Second', 'Third'],
    });

    await agent.chat('Message 1');
    await agent.chat('Message 2');
    await agent.chat('Message 3');

    const status = await agent.status();
    expect.toBeGreaterThan(status.stepCount, 2);

    await cleanup();
  })

  .test('快照创建', async () => {
    const { agent, cleanup } = await createUnitTestAgent({
      mockResponses: ['Response'],
    });

    await agent.chat('Test');

    const snapshotId = await agent.snapshot('test-snapshot');
    expect.toEqual(snapshotId, 'test-snapshot');

    await cleanup();
  })

  .test('Fork分叉', async () => {
    const { agent, cleanup } = await createUnitTestAgent({
      mockResponses: ['Response 1', 'Response 2'],
    });

    await agent.chat('Test');
    const snapshotId = await agent.snapshot();

    const fork = await agent.fork(snapshotId);

    expect.toBeTruthy(fork);
    expect.toBeTruthy(fork.agentId !== agent.agentId);

    const forkStatus = await fork.status();
    expect.toBeGreaterThan(forkStatus.stepCount, 0);

    await cleanup();
  })

  .test('流式响应与事件订阅', async () => {
    const { agent, cleanup } = await createUnitTestAgent({
      mockResponses: ['stream-1', 'stream-2'],
    });

    const chunks: string[] = [];
    const monitorEvents: string[] = [];

    const unsubscribe = agent.on('state_changed', (evt) => {
      monitorEvents.push(evt.state);
    });

    for await (const envelope of agent.chatStream('please stream')) {
      if (envelope.event.type === 'text_chunk') {
        chunks.push(envelope.event.delta);
      }
      if (envelope.event.type === 'done') break;
    }

    unsubscribe();

    expect.toBeGreaterThan(chunks.length, 0);
    expect.toContain(monitorEvents.join(','), 'WORKING');

    await cleanup();
  })

  .test('Todo 管理API在启用时可用', async () => {
    const template = {
      id: 'todo-agent',
      systemPrompt: 'you manage todos',
      runtime: {
        todo: { enabled: true, remindIntervalSteps: 2, reminderOnStart: false },
      },
    };

    const { agent, cleanup } = await createUnitTestAgent({
      customTemplate: template,
      mockResponses: ['ack'],
    });

    await agent.setTodos([{ id: '1', title: 'Item', status: 'pending' }]);
    expect.toEqual(agent.getTodos().length, 1);

    await agent.updateTodo({ id: '1', title: 'Updated', status: 'in_progress' });
    expect.toContain(agent.getTodos()[0].title, 'Updated');

    await agent.deleteTodo('1');
    expect.toEqual(agent.getTodos().length, 0);

    await cleanup();
  })

  .test('恢复Agent保留历史状态', async () => {
    const { agent, cleanup, config, deps } = await createUnitTestAgent({
      mockResponses: ['restore'],
    });

    await agent.chat('hello');
    const status = await agent.status();
    expect.toBeGreaterThan(status.stepCount, 0);

    // 等待文件系统写入完成（CI 环境可能有更激进的写缓冲）
    await new Promise((resolve) => setTimeout(resolve, 50));

    const resumed = await Agent.resume(agent.agentId, config, deps);

    const resumedResult = await resumed.chat('checking resume');
    expect.toEqual(resumedResult.status, 'ok');
    const resumedStatus = await resumed.status();
    expect.toEqual(resumedStatus.stepCount > 0, true);

    await cleanup();
  })

  .test('中断执行', async () => {
    const { agent, cleanup } = await createUnitTestAgent({
      mockResponses: ['Response'],
    });

    const chatPromise = agent.chat('Test');
    await agent.interrupt({ note: 'User interrupted' });

    await chatPromise;

    const status = await agent.status();
    expect.toEqual(status.state, 'READY');

    await cleanup();
  })

  .test('Hook 修改输出并触发消息变更钩子', async () => {
    const snapshots: any[] = [];

    const { agent, cleanup } = await createUnitTestAgent({
      mockResponses: ['原始输出'],
      customTemplate: {
        id: 'hook-behavior',
        systemPrompt: '回答时保持简短',
        hooks: {
          postModel: async (response: ModelResponse) => {
            const textBlock = response.content?.find(
              (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text'
            );
            if (textBlock) {
              textBlock.text = `${textBlock.text} [hooked]`;
            }
          },
          messagesChanged: async (snapshot: { messages?: Array<{ role: string; content: ContentBlock[] }> }) => {
            snapshots.push(snapshot);
          },
        },
      },
    });

    const result = await agent.chat('触发 Hook');

    expect.toContain(result.text ?? '', '原始输出');
    expect.toContain(result.text ?? '', '[hooked]');
    expect.toBeGreaterThan(snapshots.length, 0);
    const finalSnapshot = snapshots[snapshots.length - 1] || { messages: [] };
  const hasHookedText = (finalSnapshot.messages || []).some(
      (message: any) =>
        message.role === 'assistant' &&
        (message.content || []).some((block: any) => block.type === 'text' && typeof block.text === 'string' && block.text.includes('[hooked]'))
    );
  expect.toEqual(hasHookedText, true);

  await cleanup();
  })

  .test('Resume 保留 hook / todo / 事件状态', async () => {
    const hookLog: string[] = [];
    const snapshotLog: number[] = [];
    let runCounter = 0;

    const templateHooks = {
      preModel: async () => {
        runCounter += 1;
        hookLog.push(`preModel:${runCounter}`);
      },
      postModel: async (response: ModelResponse) => {
        const textBlock = response.content?.find(
          (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text'
        );
        if (textBlock) {
          textBlock.text = `${textBlock.text} [hook-run-${runCounter}]`;
        }
        hookLog.push(`postModel:${runCounter}`);
      },
      messagesChanged: async (snapshot: { messages?: Array<{ role: string; content: ContentBlock[] }> }) => {
        snapshotLog.push(snapshot?.messages?.length ?? -1);
      },
    } satisfies Hooks;

    const { agent, cleanup, config, deps } = await createUnitTestAgent({
      mockResponses: ['第一次输出', '第二次输出'],
      enableTodo: true,
      customTemplate: {
        id: 'resume-hooks',
        systemPrompt: '请保持对话简洁。',
        runtime: {
          todo: { enabled: true, remindIntervalSteps: 2, reminderOnStart: false },
        },
        hooks: templateHooks,
      },
    });

    await agent.setTodos([{ id: 'todo-1', title: '准备集成测试', status: 'pending' }]);
    await agent.updateTodo({ id: 'todo-1', title: '准备集成测试', status: 'in_progress' });

    const runChatAndCollect = async (instance: Agent, prompt: string) => {
      const events: string[] = [];
      for await (const envelope of instance.chatStream(prompt)) {
        events.push(envelope.event.type);
        if (envelope.event.type === 'done') {
          break;
        }
      }
      const messages = (instance as any).messages as Array<{ role: string; content: ContentBlock[] }>;
      const lastAssistant = [...messages].reverse().find((msg) => msg.role === 'assistant');
      const text = lastAssistant
        ? lastAssistant.content
            .filter((block) => block.type === 'text')
            .map((block) => (block as Extract<ContentBlock, { type: 'text' }>).text)
            .join('')
        : '';
      return { events, text };
    };

    const firstRun = await runChatAndCollect(agent, '第一次对话');
    const firstRunEvents = firstRun.events;

    expect.toBeTruthy(firstRunEvents.includes('text_chunk'));
    expect.toBeTruthy(firstRunEvents.includes('done'));
    const snapshotCountBefore = snapshotLog.length;
    expect.toContain(firstRun.text, '[hook-run-1]');
    expect.toEqual(runCounter, 1);

    const todosBefore = agent.getTodos();
    expect.toEqual(todosBefore.length, 1);
    expect.toEqual(todosBefore[0].status, 'in_progress');

    const resumed = await Agent.resume(
      agent.agentId,
      { ...config, overrides: { hooks: templateHooks } },
      deps
    );
    expect.toBeTruthy(((resumed as any).template?.hooks?.preModel), '模板 hooks 未在 resume 中保留');
    expect.toEqual(
      (resumed as any).template?.hooks?.preModel,
      (agent as any).template?.hooks?.preModel,
      'Resume 后模板 hook 函数引用发生变化'
    );
    const registeredHooks = (resumed as any).hooks?.getRegistered?.() ?? [];
    expect.toBeGreaterThan(
      registeredHooks.filter((entry: any) => entry.names.includes('preModel')).length,
      0,
      'Resume 后 HookManager 未注册 preModel 钩子'
    );

    const resumedResult = await runChatAndCollect(resumed, '第二次对话');
    const resumedEvents = resumedResult.events;

    expect.toBeTruthy(resumedEvents.includes('text_chunk'));
    expect.toBeTruthy(resumedEvents.includes('done'));
    const snapshotCountAfter = snapshotLog.length;
    expect.toContain(resumedResult.text, '[hook-run-2]', resumedResult.text);
    expect.toBeGreaterThanOrEqual(snapshotCountAfter, snapshotCountBefore);

    const todosAfterResume = resumed.getTodos();
    expect.toEqual(todosAfterResume.length, 1);
    expect.toEqual(todosAfterResume[0].status, 'in_progress');

    await resumed.updateTodo({ id: 'todo-1', title: '准备集成测试', status: 'completed' });
    const todosCompleted = resumed.getTodos();
    expect.toEqual(todosCompleted[0].status, 'completed');

    await cleanup();
  });

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
