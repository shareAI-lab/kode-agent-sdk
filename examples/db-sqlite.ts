/**
 * SQLite Database Store Example
 *
 * Demonstrates:
 * 1. Using createExtendedStore factory function to create SQLite Store
 * 2. Basic Agent creation and conversation
 * 3. Query API: querySessions, queryMessages, queryToolCalls, aggregateStats
 * 4. Database cleanup
 *
 * Run: npm run example:db-sqlite
 * No additional setup required - SQLite is file-based.
 */

import './shared/load-env';
import * as path from 'path';
import * as fs from 'fs';
import {
  Agent,
  LocalSandbox,
  createExtendedStore,
  SqliteStore,
  AnthropicProvider,
  AgentTemplateRegistry,
  ToolRegistry,
  SandboxFactory,
  builtin,
} from '@shareai-lab/kode-sdk';

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY before running this model example.');
  console.log('=== SQLite Store Example ===\n');

  // Setup paths
  const dbPath = path.join(__dirname, '../.data/example-sqlite.db');
  const storePath = path.join(__dirname, '../.data/sqlite-store');

  // Ensure directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // Method 1: Using factory function (recommended)
  console.log('1. Creating SQLite Store using factory function...');
  const store = createExtendedStore({
    type: 'sqlite',
    dbPath,
    fileStoreBaseDir: storePath,
  }) as SqliteStore;
  console.log('   Store created successfully!\n');

  // Method 2: Using class directly (alternative)
  // const store = new SqliteStore(dbPath, storePath);

  const sandbox = new LocalSandbox({ workDir: './workspace', enforceBoundary: true });
  try {
    // Setup dependencies
    const templates = new AgentTemplateRegistry();
    const tools = new ToolRegistry();
    const sandboxFactory = new SandboxFactory();

    // Register tools
    for (const tool of [...builtin.fs(), ...builtin.todo()]) {
      tools.register(tool.name, () => tool);
    }

    // Register template
    const modelId = process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-20250514';
    templates.register({
      id: 'sqlite-demo',
      systemPrompt: 'You are a helpful assistant. Keep answers concise.',
      tools: ['fs_read', 'todo_read', 'todo_write'],
      model: modelId,
      runtime: { todo: { enabled: true } },
    });

    // Create provider
    const provider = new AnthropicProvider(
      process.env.ANTHROPIC_API_KEY!,
      modelId,
      process.env.ANTHROPIC_BASE_URL
    );

    // Create agent
    console.log('2. Creating Agent...');
    const agent = await Agent.create(
      {
        templateId: 'sqlite-demo',
        sandbox,
      },
      {
        store,
        templateRegistry: templates,
        toolRegistry: tools,
        sandboxFactory,
        modelFactory: () => provider,
      }
    );
    console.log(`   Agent created: ${agent.agentId}\n`);

    console.log('3. Sending message...');
    for await (const { event } of agent.chatStream('Hello! What is 2 + 2? Answer briefly.')) {
      if (event.type === 'text_chunk') process.stdout.write(event.delta);
    }
    console.log('\n');

    // Query API demonstration
    console.log('4. Demonstrating Query APIs...\n');

    // Query sessions
    console.log('   [querySessions]');
    const sessions = await store.querySessions({ limit: 5 });
    console.log(`   Found ${sessions.length} session(s)`);
    for (const session of sessions) {
      console.log(`   - ${session.agentId} (template: ${session.templateId})`);
    }
    console.log();

    // Query messages
    console.log('   [queryMessages]');
    const messages = await store.queryMessages({ agentId: agent.agentId, limit: 10 });
    console.log(`   Found ${messages.length} message(s) for this agent`);
    console.log();

    // Query tool calls
    console.log('   [queryToolCalls]');
    const toolCalls = await store.queryToolCalls({ agentId: agent.agentId, limit: 10 });
    console.log(`   Found ${toolCalls.length} tool call(s) for this agent`);
    console.log();

    // Aggregate stats
    console.log('   [aggregateStats]');
    const stats = await store.aggregateStats(agent.agentId);
    console.log(`   Total messages: ${stats.totalMessages}`);
    console.log(`   Total tool calls: ${stats.totalToolCalls}`);
    if (stats.toolCallsByState) {
      console.log(`   Tool calls by state:`, stats.toolCallsByState);
    }
    console.log();

    console.log('=== Example Complete ===');
    console.log(`Database file: ${dbPath}`);
    console.log(`Store directory: ${storePath}`);
  } finally {
    try { await sandbox.dispose(); } finally { await store.close(); }
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exitCode = 1;
});
