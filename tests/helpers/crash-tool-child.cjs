const fs = require('node:fs');
const path = require('node:path');
const sdk = require('../../dist');

const directory = process.argv[2];
const provider = {
  model: 'controlled-crash', maxWindowSize: 200000, maxOutputTokens: 128, temperature: 0,
  toConfig() { return { provider: 'mock', model: this.model }; },
  async complete() { throw new Error('Unexpected nonstream call'); },
  async *stream() {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'crash-call', name: 'probe', input: {} } };
    yield { type: 'content_block_stop', index: 0 };
  },
};

(async () => {
  const templates = new sdk.AgentTemplateRegistry();
  templates.register({ id: 'crash', systemPrompt: 'Controlled crash test', tools: ['probe'] });
  const tools = new sdk.ToolRegistry();
  tools.register('probe', () => ({
    name: 'probe', description: 'Controlled durable side effect', input_schema: { type: 'object' },
    toDescriptor: () => ({ source: 'registered', name: 'probe', registryId: 'probe' }),
    async exec() {
      fs.appendFileSync(path.join(directory, 'effects.txt'), 'executed\n');
      setInterval(() => {}, 1000);
      process.send({ type: 'executing' });
      await new Promise(() => {});
    },
  }));
  const agent = await sdk.Agent.create({ agentId: 'crash-fixture', templateId: 'crash', model: provider,
    sandbox: { kind: 'local', workDir: directory, watchFiles: false, enforceBoundary: true },
  }, { store: new sdk.JSONStore(path.join(directory, 'store'), 1), templateRegistry: templates,
    toolRegistry: tools, sandboxFactory: new sdk.SandboxFactory(), modelFactory: () => provider,
  });
  await agent.chat('start controlled tool');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
