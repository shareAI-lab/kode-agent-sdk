/**
 * Agent核心功能单元测试
 */

import { Agent } from '../../../src/core/agent';
import path from 'path';
import fs from 'fs';
import { createUnitTestAgent, ensureCleanDir } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';
import { ContentBlock } from '../../../src/core/types';
import { Hooks } from '../../../src/core/hooks';
import { ModelProvider, ModelResponse, ModelStreamChunk } from '../../../src/infra/provider';
import { JSONStore, AgentTemplateRegistry, SandboxFactory, ToolRegistry } from '../../../src';
import { MockProvider } from '../../mock-provider';
import { TEST_ROOT } from '../../helpers/fixtures';

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
  .test('稀疏 streamed block index 不应触发模型阶段错误', async () => {
    class SparseIndexProvider implements ModelProvider {
      readonly model = 'sparse-index-provider';
      readonly maxWindowSize = 128000;
      readonly maxOutputTokens = 4096;
      readonly temperature = 0;

      async complete(): Promise<ModelResponse> {
        throw new Error('complete() should not be called');
      }

      async *stream(): AsyncIterable<ModelStreamChunk> {
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        };
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        };
        yield { type: 'content_block_stop', index: 0 };
        yield {
          type: 'content_block_start',
          index: 1000,
          content_block: { type: 'reasoning', reasoning: '' },
        };
        yield {
          type: 'content_block_delta',
          index: 1000,
          delta: { type: 'reasoning_delta', text: 'thinking' },
        };
        yield { type: 'content_block_stop', index: 1000 };
        yield {
          type: 'message_delta',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        yield { type: 'message_stop' };
      }

      toConfig() {
        return {
          provider: 'openai' as const,
          model: this.model,
          reasoningTransport: 'text' as const,
        };
      }
    }

    const workDir = path.join(TEST_ROOT, `agent-sparse-work-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    const storeDir = path.join(TEST_ROOT, `agent-sparse-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    ensureCleanDir(workDir);
    ensureCleanDir(storeDir);

    const templates = new AgentTemplateRegistry();
    templates.register({
      id: 'sparse-index-template',
      systemPrompt: 'test sparse stream indexes',
      tools: [],
      permission: { mode: 'auto' },
    });

    const agent = await Agent.create(
      {
        templateId: 'sparse-index-template',
        model: new SparseIndexProvider(),
        sandbox: { kind: 'local', workDir, enforceBoundary: true, watchFiles: false },
      },
      {
        store: new JSONStore(storeDir),
        templateRegistry: templates,
        sandboxFactory: new SandboxFactory(),
        toolRegistry: new ToolRegistry(),
      }
    );

    const errors: string[] = [];
    const stop = agent.on('error', (event) => {
      errors.push(event.message);
    });

    const result = await agent.chat('trigger sparse streamed blocks');
    stop();

    expect.toEqual(result.status, 'ok');
    expect.toEqual(result.text, 'hello');
    expect.toHaveLength(errors, 0);

    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
  })

  .test('Agent persists streamed metadata only when retaining thinking', async () => {
    class SignedStreamProvider implements ModelProvider {
      readonly model = 'signed-stream-provider';
      readonly maxWindowSize = 128000;
      readonly maxOutputTokens = 4096;
      readonly temperature = 0;

      async complete(): Promise<ModelResponse> {
        throw new Error('complete() should not be called');
      }

      async *stream(): AsyncIterable<ModelStreamChunk> {
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'reasoning',
            reasoning: '',
            meta: { thought_signature: 'signature-thought' },
          },
        };
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'reasoning_delta', text: 'PLAN' },
        };
        yield { type: 'content_block_stop', index: 0 };
        yield {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'text',
            text: '',
            meta: { thought_signature: 'signature-answer' },
          },
        };
        yield {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'ANSWER' },
        };
        yield { type: 'content_block_stop', index: 1 };
        yield {
          type: 'content_block_start',
          index: 2,
          content_block: {
            type: 'text',
            text: '',
            meta: { thought_signature: 'signature-empty' },
          },
        };
        yield { type: 'content_block_stop', index: 2 };
        yield { type: 'message_stop' };
      }

      toConfig() {
        return {
          provider: 'gemini' as const,
          model: this.model,
          reasoningTransport: 'provider' as const,
        };
      }
    }

    const workDir = path.join(TEST_ROOT, `agent-signed-work-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    const storeDir = path.join(TEST_ROOT, `agent-signed-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    ensureCleanDir(workDir);
    ensureCleanDir(storeDir);

    const templates = new AgentTemplateRegistry();
    templates.register({
      id: 'signed-stream-template',
      systemPrompt: 'test signed stream metadata',
      tools: [],
      permission: { mode: 'auto' },
    });
    const store = new JSONStore(storeDir);
    const agent = await Agent.create(
      {
        templateId: 'signed-stream-template',
        model: new SignedStreamProvider(),
        exposeThinking: true,
        retainThinking: true,
        sandbox: { kind: 'local', workDir, enforceBoundary: true, watchFiles: false },
      },
      {
        store,
        templateRegistry: templates,
        sandboxFactory: new SandboxFactory(),
        toolRegistry: new ToolRegistry(),
      }
    );

    const retainedResult = await agent.chat('preserve signed parts');
    expect.toEqual(retainedResult.text, 'ANSWER');
    const messages = await store.loadMessages(agent.agentId);
    const assistant = messages.find((message) => message.role === 'assistant');
    expect.toDeepEqual(assistant?.content, [
      {
        type: 'reasoning',
        reasoning: 'PLAN',
        meta: { thought_signature: 'signature-thought' },
      },
      {
        type: 'text',
        text: 'ANSWER',
        meta: { thought_signature: 'signature-answer' },
      },
      {
        type: 'text',
        text: '',
        meta: { thought_signature: 'signature-empty' },
      },
    ]);

    const omitWorkDir = path.join(TEST_ROOT, `agent-omit-work-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    const omitStoreDir = path.join(TEST_ROOT, `agent-omit-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    ensureCleanDir(omitWorkDir);
    ensureCleanDir(omitStoreDir);
    const omitStore = new JSONStore(omitStoreDir);
    const omitAgent = await Agent.create(
      {
        templateId: 'signed-stream-template',
        model: new SignedStreamProvider(),
        exposeThinking: true,
        retainThinking: false,
        sandbox: { kind: 'local', workDir: omitWorkDir, enforceBoundary: true, watchFiles: false },
      },
      {
        store: omitStore,
        templateRegistry: templates,
        sandboxFactory: new SandboxFactory(),
        toolRegistry: new ToolRegistry(),
      }
    );

    const progressTypes: string[] = [];
    for await (const envelope of omitAgent.chatStream('omit thought history')) {
      progressTypes.push(envelope.event.type);
    }
    expect.toDeepEqual(progressTypes, [
      'think_chunk_start',
      'think_chunk',
      'think_chunk_end',
      'text_chunk_start',
      'text_chunk',
      'text_chunk_end',
      'text_chunk_start',
      'text_chunk_end',
      'done',
    ]);
    const omitMessages = await omitStore.loadMessages(omitAgent.agentId);
    const omittedAssistant = omitMessages.find((message) => message.role === 'assistant');
    expect.toDeepEqual(omittedAssistant?.content, [
      {
        type: 'text',
        text: 'ANSWER',
        meta: { thought_signature: 'signature-answer' },
      },
      {
        type: 'text',
        text: '',
        meta: { thought_signature: 'signature-empty' },
      },
    ]);
    expect.toBeFalsy(JSON.stringify(omittedAssistant).includes('PLAN'));

    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(omitWorkDir, { recursive: true, force: true });
    fs.rmSync(omitStoreDir, { recursive: true, force: true });
  })

  .test('Agent Gemini modelConfig forwards thinking and emits isolated thought events', async () => {
    const workDir = path.join(TEST_ROOT, `agent-gemini-work-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    const storeDir = path.join(TEST_ROOT, `agent-gemini-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    ensureCleanDir(workDir);
    ensureCleanDir(storeDir);

    const templates = new AgentTemplateRegistry();
    templates.register({
      id: 'gemini-thinking-template',
      systemPrompt: 'test Gemini thinking through Agent modelConfig',
      tools: [],
      permission: { mode: 'auto' },
    });
    const store = new JSONStore(storeDir);
    const originalFetch = globalThis.fetch;
    let capturedBody: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'PLAN', thought: true },
                  { text: 'ANSWER' },
                ],
              },
            },
          ],
        })}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );
    }) as any;

    try {
      const agent = await Agent.create(
        {
          templateId: 'gemini-thinking-template',
          modelConfig: {
            provider: 'gemini',
            apiKey: 'test-key',
            model: 'gemini-2.5-flash',
            reasoningTransport: 'omit',
            thinking: { budgetTokens: 0 },
          },
          exposeThinking: true,
          retainThinking: false,
          sandbox: { kind: 'local', workDir, enforceBoundary: true, watchFiles: false },
        },
        {
          store,
          templateRegistry: templates,
          sandboxFactory: new SandboxFactory(),
          toolRegistry: new ToolRegistry(),
        }
      );

      const progressTypes: string[] = [];
      for await (const envelope of agent.chatStream('solve this')) {
        progressTypes.push(envelope.event.type);
      }
      expect.toDeepEqual(capturedBody.generationConfig.thinkingConfig, {
        thinkingBudget: 0,
        includeThoughts: true,
      });
      expect.toDeepEqual(progressTypes, [
        'think_chunk_start',
        'think_chunk',
        'think_chunk_end',
        'text_chunk_start',
        'text_chunk',
        'text_chunk_end',
        'done',
      ]);
      const messages = await store.loadMessages(agent.agentId);
      const assistant = messages.find((message) => message.role === 'assistant');
      expect.toDeepEqual(assistant?.content, [{ type: 'text', text: 'ANSWER' }]);
      expect.toBeFalsy(JSON.stringify(assistant).includes('PLAN'));
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
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
  .test('OpenSandbox sandboxId 持久化不修改模板 sandbox 配置对象', async () => {
    const workDir = path.join(TEST_ROOT, `agent-opensb-work-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    const storeDir = path.join(TEST_ROOT, `agent-opensb-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    ensureCleanDir(workDir);
    ensureCleanDir(storeDir);

    const store = new JSONStore(storeDir);
    const templates = new AgentTemplateRegistry();
    const tools = new ToolRegistry();
    const sandboxFactory = new SandboxFactory();
    const templateSandbox: Record<string, any> = {
      kind: 'opensandbox',
      endpoint: 'http://127.0.0.1:8080',
      image: 'debian:latest',
    };

    templates.register({
      id: 'opensb-template',
      systemPrompt: 'test opensandbox sandboxId persistence',
      tools: [],
      permission: { mode: 'auto' },
      sandbox: templateSandbox,
    });

    const fakeSandbox = {
      kind: 'opensandbox',
      workDir,
      fs: {
        resolve: (p: string) => (path.isAbsolute(p) ? p : path.resolve(workDir, p)),
        isInside: () => true,
        read: async () => '',
        write: async () => undefined,
        temp: () => path.resolve(workDir, '.tmp'),
        stat: async () => ({ mtimeMs: Date.now() }),
        glob: async () => [],
      },
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      getSandboxId: () => 'sbx-test-123',
      dispose: async () => undefined,
    };
    sandboxFactory.register('opensandbox', () => fakeSandbox as any);

    const agent = await Agent.create({
      templateId: 'opensb-template',
      model: new MockProvider([{ text: 'ok' }]),
    }, {
      store,
      templateRegistry: templates,
      sandboxFactory,
      toolRegistry: tools,
      modelFactory: () => new MockProvider([{ text: 'ok' }]),
    });

    expect.toEqual((templateSandbox as any).sandboxId, undefined);
    expect.toEqual((agent as any).sandboxConfig?.sandboxId, 'sbx-test-123');

    await (agent as any).sandbox?.dispose?.();
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
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

    await new Promise(r => setTimeout(r, 50)); // 等待 store 持久化
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
