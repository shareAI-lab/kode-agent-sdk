/**
 * PostgreSQL Database Store Example
 *
 * Demonstrates:
 * 1. Using createExtendedStore factory function to create PostgreSQL Store
 * 2. Connection pool configuration
 * 3. Query API with JSONB advanced queries
 * 4. Production environment best practices
 *
 * Run: npm run example:db-postgres
 *
 * Prerequisites:
 *   - PostgreSQL database server running
 *   - Database created (default: kode_agents)
 *
 * Environment variables:
 *   POSTGRES_HOST (default: localhost)
 *   POSTGRES_PORT (default: 5432)
 *   POSTGRES_DB (default: kode_agents)
 *   POSTGRES_USER (default: kode)
 *   POSTGRES_PASSWORD (required)
 *
 * Quick start with Docker:
 *   docker run --name kode-postgres \
 *     -e POSTGRES_PASSWORD=kode123 \
 *     -e POSTGRES_DB=kode_agents \
 *     -e POSTGRES_USER=kode \
 *     -p 5432:5432 \
 *     -d postgres:16-alpine
 */

import './shared/load-env';
import * as path from 'path';
import * as fs from 'fs';
import {
  Agent,
  LocalSandbox,
  createExtendedStore,
  PostgresStore,
  AnthropicProvider,
  AgentTemplateRegistry,
  ToolRegistry,
  SandboxFactory,
  builtin,
} from '@shareai-lab/kode-sdk';

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY before running this model example.');
  console.log('=== PostgreSQL Store Example ===\n');

  // Check for required environment variable
  if (!process.env.POSTGRES_PASSWORD) {
    console.log('⚠️  POSTGRES_PASSWORD not set.');
    console.log('');
    console.log('To run this example, set the following environment variables:');
    console.log('  export POSTGRES_PASSWORD=your_password');
    console.log('  export POSTGRES_HOST=localhost       # optional, default: localhost');
    console.log('  export POSTGRES_PORT=5432            # optional, default: 5432');
    console.log('  export POSTGRES_DB=kode_agents       # optional, default: kode_agents');
    console.log('  export POSTGRES_USER=kode            # optional, default: kode');
    console.log('');
    console.log('Quick start with Docker:');
    console.log('  docker run --name kode-postgres \\');
    console.log('    -e POSTGRES_PASSWORD=kode123 \\');
    console.log('    -e POSTGRES_DB=kode_agents \\');
    console.log('    -e POSTGRES_USER=kode \\');
    console.log('    -p 5432:5432 \\');
    console.log('    -d postgres:16-alpine');
    console.log('');
    console.log('Then run: POSTGRES_PASSWORD=kode123 npm run example:db-postgres');
    throw new Error('POSTGRES_PASSWORD is required.');
  }

  // Connection configuration
  const connectionConfig = {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'kode_agents',
    user: process.env.POSTGRES_USER || 'kode',
    password: process.env.POSTGRES_PASSWORD,
    // Connection pool settings (production recommendations)
    max: 20,                      // Maximum connections in pool
    idleTimeoutMillis: 30000,     // Close idle connections after 30s
    connectionTimeoutMillis: 5000, // Connection timeout 5s
  };

  const storePath = path.join(__dirname, '../.data/postgres-store');
  fs.mkdirSync(storePath, { recursive: true });

  console.log(`Connecting to PostgreSQL at ${connectionConfig.host}:${connectionConfig.port}/${connectionConfig.database}...`);

  // Method 1: Using factory function (recommended)
  console.log('\n1. Creating PostgreSQL Store using factory function...');
  const store = createExtendedStore({
    type: 'postgres', connection: connectionConfig, fileStoreBaseDir: storePath,
  }) as PostgresStore;

  // Method 2: Using class directly (alternative)
  // const store = new PostgresStore(connectionConfig, storePath);

  const sandbox = new LocalSandbox({ workDir: './workspace', enforceBoundary: true });
  try {
    await store.list();
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
      id: 'postgres-demo',
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
        templateId: 'postgres-demo',
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
    for await (const { event } of agent.chatStream('Hello! What is the capital of France? Answer in one sentence.')) {
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
    console.log(`Connected to: ${connectionConfig.host}:${connectionConfig.port}/${connectionConfig.database}`);
    console.log(`File store: ${storePath}`);
  } finally {
    try { await sandbox.dispose(); } finally { await store.close(); }
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exitCode = 1;
});
