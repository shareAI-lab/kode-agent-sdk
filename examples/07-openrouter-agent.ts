import './shared/load-env';

import {
  Agent,
  AgentDependencies,
  AgentTemplateRegistry,
  JSONStore,
  SandboxFactory,
  ToolRegistry,
} from '../src';

function createOpenRouterRuntime(setup: (ctx: { templates: AgentTemplateRegistry; tools: ToolRegistry; sandboxFactory: SandboxFactory }) => void): AgentDependencies {
  const store = new JSONStore('./.kode');
  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();

  setup({ templates, tools, sandboxFactory });

  // Note: do NOT provide deps.modelFactory here.
  // Agent will use its built-in ensureModelFactory(), which now supports provider='openrouter'.
  return {
    store,
    templateRegistry: templates,
    sandboxFactory,
    toolRegistry: tools,
  };
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const modelId = process.env.OPENROUTER_MODEL_ID;
  const baseUrl = process.env.OPENROUTER_BASE_URL;

  if (!apiKey) throw new Error('Missing OPENROUTER_API_KEY');
  if (!modelId) throw new Error('Missing OPENROUTER_MODEL_ID (e.g. openai/gpt-4.1-mini)');

  const deps = createOpenRouterRuntime(({ templates }) => {
    templates.register({
      id: 'openrouter-hello',
      systemPrompt: 'You are a helpful engineer. Keep answers short.',
      tools: [],
      runtime: {},
    });
  });

  const agent = await Agent.create(
    {
      templateId: 'openrouter-hello',
      sandbox: { kind: 'local', workDir: './workspace', enforceBoundary: true },
      modelConfig: {
        provider: 'openrouter',
        apiKey,
        model: modelId,
        baseUrl,
      },
    },
    deps
  );

  (async () => {
    for await (const envelope of agent.subscribe(['progress'])) {
      if (envelope.event.type === 'text_chunk') {
        process.stdout.write(envelope.event.delta);
      }
      if (envelope.event.type === 'done') {
        console.log('\n--- conversation complete ---');
        break;
      }
    }
  })();

  await agent.send('你好！用 5 条要点解释这个 SDK 的核心能力。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
