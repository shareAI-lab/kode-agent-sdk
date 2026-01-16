import './shared/load-env';

import { createInterface } from 'node:readline/promises';

import { MarkdownStreamRenderer } from './shared/terminal-markdown';

import {
  Agent,
  AgentDependencies,
  AgentTemplateRegistry,
  GeminiProvider,
  JSONStore,
  ModelConfig,
  ModelProvider,
  SandboxFactory,
  ToolRegistry,
  builtin,
} from '../src';

type Mode = 'modelConfig' | 'provider' | 'factory';

const mode = (process.argv[2] as Mode) || 'modelConfig';
const allowedModes: Mode[] = ['modelConfig', 'provider', 'factory'];

if (!allowedModes.includes(mode)) {
  console.error(`Unknown mode: ${mode}`);
  console.error('Usage: ts-node examples/gemini-usage.ts [modelConfig|provider|factory]');
  process.exit(1);
}

const apiKey = process.env.GEMINI_API_KEY;
const modelId = process.env.GEMINI_MODEL_ID ?? 'gemini-3.0-flash';
const baseUrl = process.env.GEMINI_BASE_URL;

function requireApiKey(value?: string): string {
  if (value) return value;
  throw new Error('GEMINI_API_KEY is required for this mode.');
}

const sandboxConfig = { kind: 'local', workDir: '.', enforceBoundary: true, watchFiles: false } as const;

function createDependencies(modelFactory?: (config: ModelConfig) => ModelProvider): AgentDependencies {
  const store = new JSONStore('./.kode');
  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();

  templates.register({
    id: 'gemini-demo',
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
      const key = config.apiKey ?? process.env.GEMINI_API_KEY;
      if (!key) {
        throw new Error('GEMINI_API_KEY is required for factory mode.');
      }
      const model = config.model ?? process.env.GEMINI_MODEL_ID ?? 'gemini-3.0-flash';
      const url = config.baseUrl ?? process.env.GEMINI_BASE_URL;
      return new GeminiProvider(key, model, url);
    });

    return Agent.create(
      {
        templateId: 'gemini-demo',
        modelConfig: {
          provider: 'gemini',
          model: modelId,
          baseUrl,
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
        templateId: 'gemini-demo',
        model: new GeminiProvider(requireApiKey(apiKey), modelId, baseUrl),
        sandbox: sandboxConfig,
      },
      deps
    );
  }

  return Agent.create(
    {
      templateId: 'gemini-demo',
      modelConfig: {
        provider: 'gemini',
        apiKey: requireApiKey(apiKey),
        model: modelId,
        baseUrl,
      },
      sandbox: sandboxConfig,
    },
    deps
  );
}

async function main() {
  console.log(`Gemini example mode: ${mode}`);
  const agent = await createAgent(mode);
  const renderer = new MarkdownStreamRenderer(process.stdout);

  agent.on('error', (evt) => {
    const detail = evt.detail?.error || evt.message;
    process.stderr.write(`\n[monitor:error] ${evt.phase} ${detail}\n`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('Enter a message. Type /exit to quit.');
  while (true) {
    const input = (await rl.question('> ')).trim();
    if (!input) {
      continue;
    }
    if (input === '/exit' || input === 'exit') {
      break;
    }

    for await (const envelope of agent.stream(input)) {
      if (envelope.event.type === 'text_chunk') {
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
        process.stdout.write('\n--- conversation complete ---\n');
        break;
      }
    }
  }

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
