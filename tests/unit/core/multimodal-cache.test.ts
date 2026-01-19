import path from 'path';
import fs from 'fs';
import { createHash } from 'node:crypto';

import {
  Agent,
  AgentConfig,
  AgentDependencies,
  AgentTemplateRegistry,
  JSONStore,
  SandboxFactory,
  ToolRegistry,
} from '../../../src';
import { ModelConfig, ModelProvider, ModelResponse, ModelStreamChunk, UploadFileInput } from '../../../src/infra/provider';
import { ContentBlock, Message } from '../../../src/core/types';
import { TestRunner, expect } from '../../helpers/utils';
import { TEST_ROOT } from '../../helpers/fixtures';
import { ensureCleanDir } from '../../helpers/setup';

const runner = new TestRunner('Multimodal/Cache');

type SharedLogs = {
  uploads: UploadFileInput[];
  messages: Message[][];
};

class CaptureProvider implements ModelProvider {
  readonly model = 'mock-model';
  readonly maxWindowSize = 200_000;
  readonly maxOutputTokens = 4096;
  readonly temperature = 0.1;

  constructor(
    private readonly providerName: string,
    private readonly logs: SharedLogs
  ) {}

  toConfig(): ModelConfig {
    return {
      provider: this.providerName,
      model: this.model,
      multimodal: {
        mode: 'url+base64',
        maxBase64Bytes: 20000000,
        allowMimeTypes: ['image/png', 'application/pdf'],
      },
    };
  }

  async complete(messages: Message[]): Promise<ModelResponse> {
    this.logs.messages.push(cloneMessages(messages));
    return {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
    };
  }

  async *stream(messages: Message[]): AsyncIterable<ModelStreamChunk> {
    this.logs.messages.push(cloneMessages(messages));
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_stop' };
  }

  async uploadFile(input: UploadFileInput) {
    this.logs.uploads.push(input);
    const hash = createHash('sha256').update(input.data).digest('hex');
    return { fileId: `file-${hash}` };
  }
}

async function createAgentWithProvider(options: {
  providerName: string;
  storeDir?: string;
  agentId?: string;
  resetStore?: boolean;
  logs: SharedLogs;
}) {
  const storeDir = options.storeDir
    ? options.storeDir
    : path.join(TEST_ROOT, `multimodal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

  if (options.resetStore ?? true) {
    ensureCleanDir(storeDir);
  } else if (!fs.existsSync(storeDir)) {
    fs.mkdirSync(storeDir, { recursive: true });
  }

  const store = new JSONStore(storeDir);
  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();

  const templateId = 'mm-test';
  templates.register({
    id: templateId,
    systemPrompt: 'You are a multimodal test agent.',
    tools: [],
    permission: { mode: 'auto' as const },
  });

  const deps: AgentDependencies = {
    store,
    templateRegistry: templates,
    sandboxFactory,
    toolRegistry: tools,
    modelFactory: (config) => new CaptureProvider(config.provider, options.logs),
  };

  const config: AgentConfig = {
    agentId: options.agentId,
    templateId,
    modelConfig: {
      provider: options.providerName,
      model: 'mock-model',
      multimodal: {
        mode: 'url+base64',
        maxBase64Bytes: 20000000,
        allowMimeTypes: ['image/png', 'application/pdf'],
      },
    },
    sandbox: { kind: 'local', workDir: storeDir, enforceBoundary: true },
  };

  const agent = await Agent.create(config, deps);

  return {
    agent,
    deps,
    config,
    storeDir,
    cleanup: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

function cloneMessages(messages: Message[]): Message[] {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content.map((block) => ({ ...block })),
    metadata: msg.metadata
      ? {
          ...msg.metadata,
          content_blocks: msg.metadata.content_blocks?.map((block) => ({ ...block })),
        }
      : undefined,
  }));
}

function findImageBlock(messages: Message[]): Extract<ContentBlock, { type: 'image' }> | undefined {
  for (const message of messages) {
    const blocks = message.metadata?.content_blocks ?? message.content;
    for (const block of blocks) {
      if (block.type === 'image') {
        return block;
      }
    }
  }
  return undefined;
}

const base64Payload = Buffer.from('multimodal-image').toString('base64');
const payloadHash = createHash('sha256').update(Buffer.from(base64Payload, 'base64')).digest('hex');
const expectedFileId = `file-${payloadHash}`;

const multimodalBlocks: ContentBlock[] = [
  { type: 'text', text: '请描述图片' },
  { type: 'image', base64: base64Payload, mime_type: 'image/png' },
];

runner
  .test('缓存命中并复用 file_id（持久化）', async () => {
    const logs: SharedLogs = { uploads: [], messages: [] };
    const env = await createAgentWithProvider({
      providerName: 'mock-a',
      logs,
    });

    await env.agent.chat(multimodalBlocks);
    expect.toEqual(logs.uploads.length, 1);

    const resumed = await Agent.resume(env.agent.agentId, { templateId: env.config.templateId }, env.deps);
    await resumed.chat(multimodalBlocks);
    expect.toEqual(logs.uploads.length, 1);

    const lastMessages = logs.messages[logs.messages.length - 1] || [];
    const imageBlock = findImageBlock(lastMessages);
    expect.toBeTruthy(imageBlock);
    expect.toEqual(imageBlock?.file_id, expectedFileId);
    expect.toEqual(imageBlock?.base64, undefined);

    await env.cleanup();
  })

  .test('缓存失效会触发重新上传', async () => {
    const logs: SharedLogs = { uploads: [], messages: [] };
    const storeDir = path.join(TEST_ROOT, `multimodal-miss-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const envA = await createAgentWithProvider({
      providerName: 'mock-a',
      logs,
      storeDir,
      agentId: 'agent-cache-miss',
      resetStore: true,
    });

    await envA.agent.chat(multimodalBlocks);
    expect.toEqual(logs.uploads.length, 1);

    const envB = await createAgentWithProvider({
      providerName: 'mock-b',
      logs,
      storeDir,
      agentId: 'agent-cache-miss',
      resetStore: false,
    });

    await envB.agent.chat(multimodalBlocks);
    expect.toEqual(logs.uploads.length, 2);

    await envA.cleanup();
  })

  .test('续聊历史包含多模态块', async () => {
    const logs: SharedLogs = { uploads: [], messages: [] };
    const env = await createAgentWithProvider({
      providerName: 'mock-a',
      logs,
    });

    await env.agent.chat(multimodalBlocks);
    await env.agent.chat('继续聊聊吧');

    const secondCall = logs.messages[1] || [];
    const imageBlock = findImageBlock(secondCall);
    expect.toBeTruthy(imageBlock);
    expect.toEqual(imageBlock?.file_id, expectedFileId);

    await env.cleanup();
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
