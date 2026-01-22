import { PostgresStore } from '../../../../src/infra/db/postgres/postgres-store';
import { TestRunner, expect } from '../../../helpers/utils';
import { AgentInfo, Message, ToolCallRecord, Snapshot } from '../../../../src/core/types';
import path from 'path';

const runner = new TestRunner('PostgresStore');

const TEST_STORE_DIR = path.join(__dirname, '../../../.tmp/postgres-store');

// PostgreSQL 连接配置（使用环境变量或默认测试值）
const PG_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5433'),
  database: process.env.POSTGRES_DB || 'kode_test',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'testpass123'
};

let store: PostgresStore | null = null;
let skipTests = false;

// 检查 PostgreSQL 是否可用
async function checkPostgresAvailable(): Promise<boolean> {
  let testStore: PostgresStore | null = null;
  try {
    testStore = new PostgresStore(PG_CONFIG, TEST_STORE_DIR);
    // 等待初始化完成（通过访问私有成员）
    await (testStore as any).initPromise;
    // 尝试简单查询
    await testStore.list();
    await testStore.close();
    return true;
  } catch (error: any) {
    if (testStore) {
      try {
        await testStore.close();
      } catch (e) {
        // 忽略关闭错误
      }
    }

    if (error.code === 'ECONNREFUSED') {
      console.log(`  ⚠️  PostgreSQL 不可用，跳过测试`);
      console.log(`  💡 启动测试数据库: docker run --name kode-postgres-test -e POSTGRES_PASSWORD=testpass123 -e POSTGRES_DB=kode_test -p 5433:5432 -d postgres:16-alpine`);
      console.log(`  📝 注意：测试会显示为"通过"，但实际未执行`);
    } else {
      console.log(`  ⚠️  PostgreSQL 连接失败，跳过测试: ${error.message}`);
      console.log(`  📝 注意：测试会显示为"通过"，但实际未执行`);
    }
    return false;
  }
}

runner
  .beforeAll(async () => {
    skipTests = !(await checkPostgresAvailable());
    if (skipTests) {
      console.log(`\n  ⚠️  以下所有测试将被跳过（因为 PostgreSQL 不可用）\n`);
      return;
    }

    store = new PostgresStore(PG_CONFIG, TEST_STORE_DIR);

    // 等待初始化完成
    await (store as any).initPromise;

    // 清理测试数据
    const testAgents = await store!.list('agt-');
    for (const agentId of testAgents) {
      if (agentId.startsWith('agt-pg-')) {
        await store!.delete(agentId);
      }
    }
  })
  .afterAll(async () => {
    if (store) {
      // 清理测试数据
      const testAgents = await store.list('agt-pg-');
      for (const agentId of testAgents) {
        await store.delete(agentId);
      }
      await store.close();
    }
  });

// ========== 5.2.1 复制所有 SqliteStore 测试用例 ==========

runner.test('saveInfo + loadInfo - 数据一致性', async () => {
  if (skipTests || !store) return;

  const agentInfo: AgentInfo = {
    agentId: 'agt-pg-test001',
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {
      model: 'claude-3-5-sonnet-20241022',
      systemPrompt: 'You are a test assistant',
      config: {}
    }
  };

  await store.saveInfo(agentInfo.agentId, agentInfo);
  const loaded = await store.loadInfo(agentInfo.agentId);

  expect.toBeTruthy(loaded, 'AgentInfo 应该被加载');
  expect.toEqual(loaded!.agentId, agentInfo.agentId);
  expect.toEqual(loaded!.templateId, agentInfo.templateId);
  expect.toEqual(loaded!.configVersion, agentInfo.configVersion);
  expect.toDeepEqual(loaded!.lineage, agentInfo.lineage);
  expect.toEqual(loaded!.messageCount, agentInfo.messageCount);
});

runner.test('saveInfo - breakpoint 字段处理', async () => {
  if (skipTests || !store) return;

  const agentInfo: AgentInfo = {
    agentId: 'agt-pg-test002',
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    breakpoint: 'PAUSED' as any,
    metadata: {}
  };

  await store.saveInfo(agentInfo.agentId, agentInfo);
  const loaded = await store.loadInfo(agentInfo.agentId);

  expect.toBeTruthy(loaded, 'AgentInfo 应该被加载');
  expect.toEqual(loaded!.breakpoint, 'PAUSED');
});

runner.test('saveMessages + loadMessages - seq 顺序验证', async () => {
  if (skipTests || !store) return;

  const agentId = 'agt-pg-test003';

  await store.saveInfo(agentId, {
    agentId,
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  const messages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }]
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there!' }]
    },
    {
      role: 'user',
      content: [{ type: 'text', text: 'How are you?' }]
    }
  ];

  await store.saveMessages(agentId, messages);
  const loaded = await store.loadMessages(agentId);

  expect.toHaveLength(loaded, 3);
  expect.toEqual(loaded[0].role, 'user');
  expect.toEqual(loaded[1].role, 'assistant');
  expect.toEqual(loaded[2].role, 'user');
  expect.toEqual((loaded[0].content[0] as any).text, 'Hello');
});

runner.test('saveMessages - message_count 自动更新', async () => {
  if (skipTests || !store) return;

  const agentId = 'agt-pg-test004';

  await store.saveInfo(agentId, {
    agentId,
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'Test 1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Test 2' }] }
  ];

  await store.saveMessages(agentId, messages);
  const info = await store.loadInfo(agentId);

  expect.toEqual(info!.messageCount, 2);
});

runner.test('saveToolCallRecords + loadToolCallRecords - JSONB 字段', async () => {
  if (skipTests || !store) return;

  const agentId = 'agt-pg-test005';

  await store.saveInfo(agentId, {
    agentId,
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  const records: ToolCallRecord[] = [
    {
      id: 'call_pg_001',
      name: 'fs_read',
      input: { path: '/test.txt' },
      state: 'COMPLETED' as any,
      approval: { required: false },
      result: { content: 'file content' },
      isError: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      auditTrail: [
        { state: 'PENDING' as any, timestamp: Date.now() },
        { state: 'COMPLETED' as any, timestamp: Date.now() }
      ]
    }
  ];

  await store.saveToolCallRecords(agentId, records);
  const loaded = await store.loadToolCallRecords(agentId);

  expect.toHaveLength(loaded, 1);
  expect.toEqual(loaded[0].id, 'call_pg_001');
  expect.toEqual(loaded[0].name, 'fs_read');
  expect.toDeepEqual(loaded[0].input, { path: '/test.txt' });
  expect.toEqual(loaded[0].isError, false);
  expect.toHaveLength(loaded[0].auditTrail, 2);
});

runner.test('saveSnapshot + loadSnapshot + listSnapshots', async () => {
  if (skipTests || !store) return;

  const agentId = 'agt-pg-test006';

  await store.saveInfo(agentId, {
    agentId,
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  const snapshot: Snapshot = {
    id: 'snap:pg_001',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Snapshot test' }] }
    ],
    lastSfpIndex: 0,
    lastBookmark: { seq: 1, timestamp: Date.now() },
    createdAt: new Date().toISOString()
  };

  await store.saveSnapshot(agentId, snapshot);

  const loaded = await store.loadSnapshot(agentId, 'snap:pg_001');
  expect.toBeTruthy(loaded, 'Snapshot 应该被加载');
  expect.toEqual(loaded!.id, 'snap:pg_001');
  expect.toHaveLength(loaded!.messages, 1);

  const snapshots = await store.listSnapshots(agentId);
  expect.toHaveLength(snapshots, 1);
  expect.toEqual(snapshots[0].id, 'snap:pg_001');
});

runner.test('querySessions - 基本查询', async () => {
  if (skipTests || !store) return;

  for (let i = 0; i < 3; i++) {
    await store.saveInfo(`agt-pg-query${i}`, {
      agentId: `agt-pg-query${i}`,
      templateId: 'test-template',
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
      configVersion: 'v2.7.0',
      lineage: [],
      messageCount: i * 10,
      lastSfpIndex: -1,
      metadata: {}
    });
  }

  const sessions = await store.querySessions({});
  expect.toBeGreaterThanOrEqual(sessions.length, 3);
});

runner.test('querySessions - 分页查询', async () => {
  if (skipTests || !store) return;

  const sessions1 = await store.querySessions({ limit: 2, offset: 0 });
  const sessions2 = await store.querySessions({ limit: 2, offset: 2 });

  expect.toBeGreaterThanOrEqual(sessions1.length, 1);
  expect.toBeTruthy(sessions1.length <= 2);
});

runner.test('queryMessages - 按 agentId 过滤', async () => {
  if (skipTests || !store) return;

  const agentId = 'agt-pg-msg001';
  await store.saveInfo(agentId, {
    agentId,
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  await store.saveMessages(agentId, [
    { role: 'user', content: [{ type: 'text', text: 'Test' }] }
  ]);

  const messages = await store.queryMessages({ agentId });
  expect.toBeGreaterThanOrEqual(messages.length, 1);
});

runner.test('queryToolCalls - 按 toolName 过滤', async () => {
  if (skipTests || !store) return;

  const agentId = 'agt-pg-tool001';
  await store.saveInfo(agentId, {
    agentId,
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  await store.saveToolCallRecords(agentId, [
    {
      id: 'call_pg_002',
      name: 'fs_read',
      input: {},
      state: 'COMPLETED' as any,
      approval: { required: false },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      auditTrail: []
    }
  ]);

  const fsReadCalls = await store.queryToolCalls({ agentId, toolName: 'fs_read' });
  expect.toBeGreaterThanOrEqual(fsReadCalls.length, 1);
  fsReadCalls.forEach(call => expect.toEqual(call.name, 'fs_read'));
});

runner.test('aggregateStats - 统计准确性', async () => {
  if (skipTests || !store) return;

  const agentId = 'agt-pg-stats001';

  await store.saveInfo(agentId, {
    agentId,
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  await store.saveMessages(agentId, [
    { role: 'user', content: [{ type: 'text', text: 'Test 1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Test 2' }] }
  ]);

  await store.saveToolCallRecords(agentId, [
    {
      id: 'call_pg_003',
      name: 'fs_read',
      input: {},
      state: 'COMPLETED' as any,
      approval: { required: false },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      auditTrail: []
    }
  ]);

  await store.saveSnapshot(agentId, {
    id: 'snap:pg_stats001',
    messages: [],
    lastSfpIndex: 0,
    lastBookmark: { seq: 0, timestamp: Date.now() },
    createdAt: new Date().toISOString()
  });

  const stats = await store.aggregateStats(agentId);

  expect.toEqual(stats.totalMessages, 2);
  expect.toEqual(stats.totalToolCalls, 1);
  expect.toEqual(stats.totalSnapshots, 1);
  expect.toBeTruthy(stats.toolCallsByName);
  expect.toEqual(stats.toolCallsByName!['fs_read'], 1);
});

runner.test('exists - Agent 存在性检查', async () => {
  if (skipTests || !store) return;

  const agentId = 'agt-pg-exists001';

  const existsBefore = await store.exists(agentId);
  expect.toEqual(existsBefore, false);

  await store.saveInfo(agentId, {
    agentId,
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  const existsAfter = await store.exists(agentId);
  expect.toEqual(existsAfter, true);
});

runner.test('delete - CASCADE 删除', async () => {
  if (skipTests || !store) return;

  const agentId = 'agt-pg-delete001';

  await store.saveInfo(agentId, {
    agentId,
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  await store.saveMessages(agentId, [
    { role: 'user', content: [{ type: 'text', text: 'Test' }] }
  ]);

  await store.delete(agentId);

  const exists = await store.exists(agentId);
  expect.toEqual(exists, false);

  const messages = await store.loadMessages(agentId);
  expect.toHaveLength(messages, 0);
});

runner.test('list - Agent 列表查询', async () => {
  if (skipTests || !store) return;

  await store.saveInfo('agt-pg-list001', {
    agentId: 'agt-pg-list001',
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  await store.saveInfo('agt-pg-list002', {
    agentId: 'agt-pg-list002',
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  const allAgents = await store.list();
  expect.toBeGreaterThanOrEqual(allAgents.length, 2);

  const prefixedAgents = await store.list('agt-pg-list');
  expect.toBeGreaterThanOrEqual(prefixedAgents.length, 2);
});

// ========== 5.2.2 测试 JSONB 特定功能 ==========

runner.test('JSONB 存储和查询 - lineage 字段', async () => {
  if (skipTests || !store) return;

  const agentInfo: AgentInfo = {
    agentId: 'agt-pg-jsonb001',
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: ['parent1', 'parent2', 'parent3'],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {
      custom: { nested: { value: 123 } }
    }
  };

  await store.saveInfo(agentInfo.agentId, agentInfo);
  const loaded = await store.loadInfo(agentInfo.agentId);

  // JSONB 应该保持数据类型和结构
  expect.toDeepEqual(loaded!.lineage, ['parent1', 'parent2', 'parent3']);
  expect.toDeepEqual(loaded!.metadata, { custom: { nested: { value: 123 } } });
});

// ========== 5.2.3 测试连接池 ==========

runner.test('连接池 - 并发操作', async () => {
  if (skipTests || !store) return;

  // 并发创建多个 agents
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(
      store.saveInfo(`agt-pg-pool${i}`, {
        agentId: `agt-pg-pool${i}`,
        templateId: 'test-template',
        createdAt: new Date().toISOString(),
        configVersion: 'v2.7.0',
        lineage: [],
        messageCount: 0,
        lastSfpIndex: -1,
        metadata: {}
      })
    );
  }

  await Promise.all(promises);

  // 验证所有 agents 都被创建
  for (let i = 0; i < 5; i++) {
    const exists = await store.exists(`agt-pg-pool${i}`);
    expect.toEqual(exists, true);
  }
});

// ========== 5.2.4 测试初始化检测 (ensureInitialized) ==========

runner.test('ensureInitialized - 初始化完成前调用方法会等待', async () => {
  if (skipTests) return;

  // 创建新的 store 实例，不等待 initPromise
  const newStore = new PostgresStore(PG_CONFIG, TEST_STORE_DIR);

  // 立即调用方法（应该会自动等待初始化完成）
  const agents = await newStore.list();

  // 如果能执行到这里，说明 ensureInitialized 正确等待了初始化
  expect.toBeTruthy(Array.isArray(agents), '应该返回数组');

  await newStore.close();
});

runner.test('ensureInitialized - 并发调用时都能正确等待初始化', async () => {
  if (skipTests) return;

  // 创建新的 store 实例
  const newStore = new PostgresStore(PG_CONFIG, TEST_STORE_DIR);

  // 同时发起多个请求（不等待 initPromise）
  const [agents, exists, sessions] = await Promise.all([
    newStore.list(),
    newStore.exists('agt-pg-nonexistent'),
    newStore.querySessions({ limit: 1 })
  ]);

  // 所有请求都应该正常完成
  expect.toBeTruthy(Array.isArray(agents), 'list() 应该返回数组');
  expect.toEqual(exists, false, 'exists() 应该返回 false');
  expect.toBeTruthy(Array.isArray(sessions), 'querySessions() 应该返回数组');

  await newStore.close();
});

runner.test('ensureInitialized - 初始化失败时方法调用会抛出错误', async () => {
  // 使用错误的配置创建 store
  const badConfig = {
    host: 'invalid-host-that-does-not-exist',
    port: 9999,
    database: 'nonexistent',
    user: 'nobody',
    password: 'wrong',
    connectionTimeoutMillis: 1000  // 1秒超时，快速失败
  };

  const badStore = new PostgresStore(badConfig, TEST_STORE_DIR);

  let errorThrown = false;
  let errorMessage = '';

  try {
    // 调用方法应该会抛出初始化错误
    await badStore.list();
  } catch (error: any) {
    errorThrown = true;
    errorMessage = error.message || '';
  }

  expect.toBeTruthy(errorThrown, '应该抛出错误');
  // 错误信息应该与连接相关（不同环境可能返回不同错误码）
  expect.toBeTruthy(
    errorMessage.includes('ENOTFOUND') ||
    errorMessage.includes('ECONNREFUSED') ||
    errorMessage.includes('EAI_AGAIN') ||
    errorMessage.includes('timeout') ||
    errorMessage.includes('connect'),
    `错误信息应该与连接相关: ${errorMessage}`
  );

  // 尝试关闭（可能会失败，忽略错误）
  try {
    await badStore.close();
  } catch (e) {
    // 忽略
  }
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
