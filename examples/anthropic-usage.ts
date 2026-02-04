import './shared/load-env';

import { createInterface } from 'node:readline/promises';

import { MarkdownStreamRenderer } from './shared/terminal-markdown';
import { createErrorTracker } from './shared/agent-error';
import { loadLocalFile, parseReadCommand } from './shared/multimodal';

import {
  Agent,
  AgentDependencies,
  AgentTemplateRegistry,
  AnthropicProvider,
  ContentBlock,
  JSONStore,
  ModelConfig,
  ModelProvider,
  SandboxFactory,
  ToolRegistry,
  builtin,
} from '@shareai-lab/kode-sdk';

type Mode = 'modelConfig' | 'provider' | 'factory';

const mode = (process.argv[2] as Mode) || 'modelConfig';
const allowedModes: Mode[] = ['modelConfig', 'provider', 'factory'];

if (!allowedModes.includes(mode)) {
  console.error(`Unknown mode: ${mode}`);
  console.error('Usage: ts-node examples/anthropic-usage.ts [modelConfig|provider|factory]');
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
const modelId = process.env.ANTHROPIC_MODEL_ID ?? 'claude-3-5-sonnet-20241022';
const baseUrl = process.env.ANTHROPIC_BASE_URL;

function requireApiKey(value?: string): string {
  if (value) return value;
  throw new Error('ANTHROPIC_API_KEY is required for this mode.');
}

const sandboxConfig = { kind: 'local', workDir: '.', enforceBoundary: true, watchFiles: false } as const;
const multimodalConfig = {
  mode: 'url+base64',
  maxBase64Bytes: 20000000,
  audio: {
    // Anthropic doesn't support audio natively; this callback transcribes audio to text.
    // In production, call Whisper API or another STT service here.
    customTranscriber: async (audio: { base64?: string; url?: string; mimeType?: string }) => {
      console.log('[info] customTranscriber called — returning placeholder transcription');
      // Replace with real STT implementation, e.g.:
      // const resp = await openai.audio.transcriptions.create({ file: ..., model: 'whisper-1' });
      // return resp.text;
      return '[Placeholder transcription — integrate your STT service here]';
    },
  },
  video: {
    // Anthropic doesn't support video natively; this callback extracts frames as images.
    // In production, use ffmpeg or a video processing library to extract key frames.
    customFrameExtractor: async (video: { base64?: string; url?: string; mimeType?: string }) => {
      console.log('[info] customFrameExtractor called — extracting placeholder frames');
      if (video.base64) {
        return [{ base64: video.base64, mimeType: 'image/jpeg' }];
      }
      return [];
    },
  },
} as const;

type ErrorTracker = ReturnType<typeof createErrorTracker>;

async function streamConversation(
  agent: Agent,
  renderer: MarkdownStreamRenderer,
  tracker: ErrorTracker,
  input: string | ContentBlock[]
): Promise<{ wroteText: boolean; errorMessage: string | null; text: string }> {
  const token = tracker.beginCall();
  let wroteText = false;
  let collectedText = '';
  let sawDone = false;
  try {
    for await (const envelope of agent.stream(input)) {
      if (envelope.event.type === 'text_chunk') {
        wroteText = true;
        collectedText += envelope.event.delta;
        renderer.write(envelope.event.delta);
      }
      if (envelope.event.type === 'tool:start') {
        renderer.flushLine();
        const call = envelope.event.call;
        process.stdout.write(`[tool:start] ${call.name} (${call.id})\n`);
      }
      if (envelope.event.type === 'tool:end') {
        renderer.flushLine();
        const call = envelope.event.call;
        const ok = call.isError ? 'no' : 'yes';
        process.stdout.write(`[tool:end] ${call.name} ok=${ok}\n`);
      }
      if (envelope.event.type === 'tool:error') {
        renderer.flushLine();
        const call = envelope.event.call;
        process.stdout.write(`[tool:error] ${call.name} ${envelope.event.error}\n`);
      }
      if (envelope.event.type === 'done') {
        renderer.finish();
        sawDone = true;
        break;
      }
    }
  } catch (error: any) {
    const detail = error?.message || String(error);
    tracker.finishCall(token);
    if (!sawDone) {
      renderer.finish();
    }
    return { wroteText, errorMessage: detail || 'Model call failed.', text: collectedText };
  }
  const errorMessage = tracker.finishCall(token);
  return { wroteText, errorMessage, text: collectedText };
}

function normalizeAnthropicBaseUrl(value?: string): string {
  const fallback = 'https://api.anthropic.com';
  if (!value) return fallback;
  const trimmed = value.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
}

async function uploadAnthropicFile(
  key: string,
  url: string | undefined,
  file: { data: Buffer; filename: string; mimeType: string }
): Promise<string> {
  const endpoint = `${normalizeAnthropicBaseUrl(url)}/v1/files`;
  const FormDataCtor = (globalThis as any).FormData;
  const BlobCtor = (globalThis as any).Blob;
  if (!FormDataCtor || !BlobCtor) {
    throw new Error('FormData/Blob is not available in this runtime.');
  }
  const form = new FormDataCtor();
  form.append('file', new BlobCtor([file.data], { type: file.mimeType }), file.filename);
  form.append('purpose', 'document');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'files-api-2025-04-14',
    },
    body: form,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic files API error: ${response.status} ${error}`);
  }

  const data: any = await response.json();
  const fileId = data?.id ?? data?.file_id;
  if (!fileId) {
    throw new Error('Anthropic files API did not return a file id.');
  }
  return fileId;
}

function createDependencies(modelFactory?: (config: ModelConfig) => ModelProvider): AgentDependencies {
  const store = new JSONStore('./.kode');
  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();

  templates.register({
    id: 'anthropic-demo',
    systemPrompt: 'You are a helpful engineer. Use fs_read to read files before answering file-based requests.',
    tools: ['fs_read', 'todo_read', 'todo_write'],
    runtime: { todo: { enabled: true, reminderOnStart: true } },
  });

  for (const tool of builtin.fs()) {
    tools.register(tool.name, () => tool);
  }
  for (const tool of builtin.todo()) {
    tools.register(tool.name, () => tool);
  }

  const deps: AgentDependencies = {
    store,
    templateRegistry: templates,
    sandboxFactory,
    toolRegistry: tools,
  };

  if (modelFactory) {
    deps.modelFactory = modelFactory;
  }

  return deps;
}

async function createAgent(modeSelected: Mode): Promise<Agent> {
  if (modeSelected === 'factory') {
    const deps = createDependencies((config) => {
      const key = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!key) {
        throw new Error('ANTHROPIC_API_KEY is required for factory mode.');
      }
      const model = config.model ?? process.env.ANTHROPIC_MODEL_ID ?? 'claude-3-5-sonnet-20241022';
      const url = config.baseUrl ?? process.env.ANTHROPIC_BASE_URL;
      return new AnthropicProvider(key, model, url, undefined, { multimodal: multimodalConfig });
    });

    return Agent.create(
      {
        templateId: 'anthropic-demo',
        modelConfig: {
          provider: 'anthropic',
          model: modelId,
          baseUrl,
          multimodal: multimodalConfig,
        },
        sandbox: sandboxConfig,
      },
      deps
    );
  }

  const deps = createDependencies();

  if (modeSelected === 'provider') {
    return Agent.create(
      {
        templateId: 'anthropic-demo',
        model: new AnthropicProvider(requireApiKey(apiKey), modelId, baseUrl, undefined, { multimodal: multimodalConfig }),
        sandbox: sandboxConfig,
      },
      deps
    );
  }

  return Agent.create(
    {
      templateId: 'anthropic-demo',
      modelConfig: {
        provider: 'anthropic',
        apiKey: requireApiKey(apiKey),
        model: modelId,
        baseUrl,
        multimodal: multimodalConfig,
      },
      sandbox: sandboxConfig,
    },
    deps
  );
}

async function main() {
  console.log(`Anthropic example mode: ${mode}`);
  const agent = await createAgent(mode);
  const renderer = new MarkdownStreamRenderer(process.stdout);
  const tracker = createErrorTracker(agent);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('Enter a message. Type /exit to quit.');
  console.log('Use "读取 <path>" or "read <path>" to load a local PDF/image/audio/video.');
  console.log('  Audio: auto-transcribed via customTranscriber callback (Whisper, etc.)');
  console.log('  Video: auto-degraded to extracted frames via customFrameExtractor callback');
  console.log('Optional prompt: "读取 <path> | <prompt>" or "读取 <path>，<prompt>" or "read <path> <prompt>".');
  while (true) {
    const input = (await rl.question('> ')).trim();
    if (!input) {
      continue;
    }
    if (input === '/exit' || input === 'exit') {
      break;
    }

    const readCommand = parseReadCommand(input);
    if (readCommand) {
      try {
        const file = loadLocalFile(readCommand);
        const sizeMb = (file.data.length / 1024 / 1024).toFixed(2);
        process.stdout.write(`\n[info] loading ${file.filename} (${sizeMb} MB)\n`);
        const prompt =
          file.prompt ??
          (file.kind === 'pdf'
            ? 'Summarize the PDF in 3 bullet points.'
            : file.kind === 'audio'
            ? 'Describe or transcribe this audio.'
            : file.kind === 'video'
            ? 'Describe what happens in this video.'
            : 'Describe the image in one sentence.');
        const blocks: ContentBlock[] = [{ type: 'text', text: prompt }];

        if (file.kind === 'image') {
          blocks.push({
            type: 'image',
            base64: file.data.toString('base64'),
            mime_type: file.mimeType,
          });
        } else if (file.kind === 'audio') {
          blocks.push({
            type: 'audio',
            base64: file.data.toString('base64'),
            mime_type: file.mimeType,
          });
        } else if (file.kind === 'video') {
          blocks.push({
            type: 'video',
            base64: file.data.toString('base64'),
            mime_type: file.mimeType,
          });
        } else {
          const fileId = process.env.ANTHROPIC_FILE_ID
            ? process.env.ANTHROPIC_FILE_ID
            : await uploadAnthropicFile(requireApiKey(apiKey), baseUrl, file);
          blocks.push({ type: 'file', file_id: fileId, mime_type: file.mimeType });
        }

        const fileTracker = createErrorTracker(agent);
        let errorMessage: string | null = null;
        let wroteText = false;
        try {
          const result = await streamConversation(agent, renderer, fileTracker, blocks);
          wroteText = result.wroteText;
          errorMessage = result.errorMessage;
        } finally {
          fileTracker.dispose();
        }

        if (errorMessage && !wroteText) {
          const fallback = `文件读取失败：${errorMessage}。请确认当前网关支持多模态输入。`;
          const fallbackResult = await streamConversation(agent, renderer, tracker, fallback);
          if (!fallbackResult.wroteText) {
            process.stdout.write(`${fallback}\n`);
          }
          process.stdout.write('\n--- conversation complete ---\n');
        } else {
          process.stdout.write('\n--- conversation complete ---\n');
        }
      } catch (error: any) {
        const detail = error?.message || String(error);
        const fallback = `无法读取文件：${readCommand.path}。${detail}。请确认路径后重试。`;
        const fallbackResult = await streamConversation(agent, renderer, tracker, fallback);
        if (!fallbackResult.wroteText) {
          process.stdout.write(`${fallback}\n`);
        }
        process.stdout.write('\n--- conversation complete ---\n');
      }
      continue;
    }

    const result = await streamConversation(agent, renderer, tracker, input);
    if (result.errorMessage && !result.wroteText) {
      const fallback = `模型调用失败：${result.errorMessage}。请稍后重试。`;
      const fallbackResult = await streamConversation(agent, renderer, tracker, fallback);
      if (!fallbackResult.wroteText) {
        process.stdout.write(`${fallback}\n`);
      }
      process.stdout.write('\n--- conversation complete ---\n');
    } else {
      process.stdout.write('\n--- conversation complete ---\n');
    }
  }

  rl.close();
  tracker.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
