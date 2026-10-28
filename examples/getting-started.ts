import {
  Agent, AnthropicProvider, JSONStore, AgentTemplateRegistry,
  ToolRegistry, SandboxFactory, LocalSandbox, ModelProvider,
} from '@shareai-lab/kode-sdk';
import { MockProvider } from './shared/mock-provider';

export async function runGettingStarted(provider: ModelProvider, options: {
  storeDir?: string;
  workDir?: string;
  write?: (text: string) => void;
} = {}): Promise<string> {
  const templates = new AgentTemplateRegistry();
  templates.register({ id: 'assistant', systemPrompt: 'You are a helpful assistant. Keep answers short.' });
  const sandbox = new LocalSandbox({ workDir: options.workDir ?? './workspace', enforceBoundary: true, watchFiles: false });
  try {
    const agent = await Agent.create(
      { templateId: 'assistant', model: provider, sandbox },
      {
        store: new JSONStore(options.storeDir ?? './.kode'),
        templateRegistry: templates,
        toolRegistry: new ToolRegistry(),
        sandboxFactory: new SandboxFactory(),
        modelFactory: () => provider,
      }
    );
    let text = '';
    for await (const { event } of agent.chatStream('Hello!')) {
      if (event.type === 'text_chunk') {
        text += event.delta;
        (options.write ?? ((chunk) => process.stdout.write(chunk)))(event.delta);
      }
    }
    return text;
  } finally {
    await sandbox.dispose();
  }
}

async function main() {
  let provider: ModelProvider;
  if (process.argv.includes('--mock')) {
    provider = new MockProvider();
  } else {
    require('./shared/load-env');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY, or use --mock for an offline run.');
    provider = new AnthropicProvider(
      apiKey,
      process.env.ANTHROPIC_MODEL_ID ?? 'claude-sonnet-4-5-20250929',
      process.env.ANTHROPIC_BASE_URL
    );
  }
  await runGettingStarted(provider);
  console.log();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
