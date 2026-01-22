import { SqliteStore } from '../../../../src/infra/db/sqlite/sqlite-store';
import { TestRunner, expect } from '../../../helpers/utils';
import { AgentInfo, Message, ToolCallRecord, Snapshot } from '../../../../src/core/types';
import path from 'path';
import fs from 'fs';

const runner = new TestRunner('SqliteStore');

// 测试数据库路径
const TEST_DB_PATH = path.join(__dirname, '../../../.tmp/test-sqlite.db');
const TEST_STORE_DIR = path.join(__dirname, '../../../.tmp/sqlite-store');

let store: SqliteStore;

// 清理测试数据
function cleanupTestData() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
  if (fs.existsSync(TEST_STORE_DIR)) {
    fs.rmSync(TEST_STORE_DIR, { recursive: true, force: true });
  }
}

runner
  .beforeAll(() => {
    cleanupTestData();
    // 确保测试目录存在
    const testDataDir = path.dirname(TEST_DB_PATH);
    if (!fs.existsSync(testDataDir)) {
      fs.mkdirSync(testDataDir, { recursive: true });
    }
    store = new SqliteStore(TEST_DB_PATH, TEST_STORE_DIR);
  })
  .afterAll(() => {
    cleanupTestData();
  });

// ========== 5.1.1 测试基础 CRUD - AgentInfo ==========

runner.test('saveInfo + loadInfo - 数据一致性', async () => {
  const agentInfo: AgentInfo = {
    agentId: 'agt-test001',
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
  const agentInfo: AgentInfo = {
    agentId: 'agt-test002',
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

runner.test('saveInfo - lastBookmark 字段处理', async () => {
  const agentInfo: AgentInfo = {
    agentId: 'agt-test003',
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    lastBookmark: { seq: 10, timestamp: 1234567890 },
    metadata: {}
  };

  await store.saveInfo(agentInfo.agentId, agentInfo);
  const loaded = await store.loadInfo(agentInfo.agentId);

  expect.toBeTruthy(loaded, 'AgentInfo 应该被加载');
  expect.toDeepEqual(loaded!.lastBookmark, { seq: 10, timestamp: 1234567890 });
});

// ========== 5.1.2 测试基础 CRUD - Messages ==========

runner.test('saveMessages + loadMessages - seq 顺序验证', async () => {
  const agentId = 'agt-test004';

  // 先创建 agent
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
  const agentId = 'agt-test005';

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

// ========== 5.1.3 测试基础 CRUD - ToolCallRecords ==========

runner.test('saveToolCallRecords + loadToolCallRecords - JSON 字段验证', async () => {
  const agentId = 'agt-test006';

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
      id: 'call_001',
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
  expect.toEqual(loaded[0].id, 'call_001');
  expect.toEqual(loaded[0].name, 'fs_read');
  expect.toDeepEqual(loaded[0].input, { path: '/test.txt' });
  expect.toEqual(loaded[0].isError, false);
  expect.toHaveLength(loaded[0].auditTrail, 2);
});

runner.test('saveToolCallRecords - boolean 转 INTEGER', async () => {
  const agentId = 'agt-test007';

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
      id: 'call_002',
      name: 'test_tool',
      input: {},
      state: 'FAILED' as any,
      approval: { required: false },
      error: 'Test error',
      isError: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      auditTrail: []
    }
  ];

  await store.saveToolCallRecords(agentId, records);
  const loaded = await store.loadToolCallRecords(agentId);

  expect.toEqual(loaded[0].isError, true);
  expect.toEqual(loaded[0].error, 'Test error');
});

// ========== 5.1.4 测试基础 CRUD - Snapshots ==========

runner.test('saveSnapshot + loadSnapshot + listSnapshots', async () => {
  const agentId = 'agt-test008';

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
    id: 'snap:001',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Snapshot test' }] }
    ],
    lastSfpIndex: 0,
    lastBookmark: { seq: 1, timestamp: Date.now() },
    createdAt: new Date().toISOString()
  };

  await store.saveSnapshot(agentId, snapshot);

  // 测试 loadSnapshot
  const loaded = await store.loadSnapshot(agentId, 'snap:001');
  expect.toBeTruthy(loaded, 'Snapshot 应该被加载');
  expect.toEqual(loaded!.id, 'snap:001');
  expect.toHaveLength(loaded!.messages, 1);

  // 测试 listSnapshots
  const snapshots = await store.listSnapshots(agentId);
  expect.toHaveLength(snapshots, 1);
  expect.toEqual(snapshots[0].id, 'snap:001');
});

// ========== 5.1.5 测试查询功能 ==========

runner.test('querySessions - 基本查询', async () => {
  // 创建多个 agents
  for (let i = 0; i < 3; i++) {
    await store.saveInfo(`agt-query${i}`, {
      agentId: `agt-query${i}`,
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

runner.test('querySessions - 按 templateId 过滤', async () => {
  await store.saveInfo('agt-template1', {
    agentId: 'agt-template1',
    templateId: 'template-A',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  const sessions = await store.querySessions({ templateId: 'template-A' });
  expect.toBeGreaterThanOrEqual(sessions.length, 1);
  expect.toEqual(sessions.find(s => s.agentId === 'agt-template1')?.templateId, 'template-A');
});

runner.test('querySessions - 分页查询', async () => {
  const sessions1 = await store.querySessions({ limit: 2, offset: 0 });
  const sessions2 = await store.querySessions({ limit: 2, offset: 2 });

  expect.toBeGreaterThanOrEqual(sessions1.length, 1);
  expect.toBeTruthy(sessions1.length <= 2);
});

runner.test('queryMessages - 按 agentId 过滤', async () => {
  const agentId = 'agt-msg001';
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

runner.test('queryMessages - 按 role 过滤', async () => {
  const agentId = 'agt-msg002';
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
    { role: 'user', content: [{ type: 'text', text: 'User msg' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Assistant msg' }] }
  ]);

  const userMessages = await store.queryMessages({ agentId, role: 'user' });
  expect.toBeGreaterThanOrEqual(userMessages.length, 1);
  userMessages.forEach(msg => expect.toEqual(msg.role, 'user'));
});

runner.test('queryToolCalls - 按 toolName 过滤', async () => {
  const agentId = 'agt-tool001';
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
      id: 'call_003',
      name: 'fs_read',
      input: {},
      state: 'COMPLETED' as any,
      approval: { required: false },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      auditTrail: []
    },
    {
      id: 'call_004',
      name: 'fs_write',
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

// ========== 5.1.6 测试聚合功能 ==========

runner.test('aggregateStats - 统计准确性', async () => {
  const agentId = 'agt-stats001';

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

  // 添加消息
  await store.saveMessages(agentId, [
    { role: 'user', content: [{ type: 'text', text: 'Test 1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Test 2' }] }
  ]);

  // 添加工具调用
  await store.saveToolCallRecords(agentId, [
    {
      id: 'call_005',
      name: 'fs_read',
      input: {},
      state: 'COMPLETED' as any,
      approval: { required: false },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      auditTrail: []
    }
  ]);

  // 添加快照
  await store.saveSnapshot(agentId, {
    id: 'snap:stats001',
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

// ========== 5.1.7 测试事务一致性 ==========

runner.test('saveMessages - 事务回滚测试', async () => {
  const agentId = 'agt-transaction001';

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

  // 第一次保存
  await store.saveMessages(agentId, [
    { role: 'user', content: [{ type: 'text', text: 'First' }] }
  ]);

  // 第二次保存（应该替换）
  await store.saveMessages(agentId, [
    { role: 'user', content: [{ type: 'text', text: 'Second' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Response' }] }
  ]);

  const messages = await store.loadMessages(agentId);
  expect.toHaveLength(messages, 2);
  expect.toEqual((messages[0].content[0] as any).text, 'Second');
});

// ========== 5.1.8 测试生命周期方法 ==========

runner.test('exists - Agent 存在性检查', async () => {
  const agentId = 'agt-exists001';

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
  const agentId = 'agt-delete001';

  // 创建完整数据
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

  await store.saveToolCallRecords(agentId, [
    {
      id: 'call_006',
      name: 'test_tool',
      input: {},
      state: 'COMPLETED' as any,
      approval: { required: false },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      auditTrail: []
    }
  ]);

  // 删除
  await store.delete(agentId);

  // 验证删除
  const exists = await store.exists(agentId);
  expect.toEqual(exists, false);

  const messages = await store.loadMessages(agentId);
  expect.toHaveLength(messages, 0);

  const toolCalls = await store.loadToolCallRecords(agentId);
  expect.toHaveLength(toolCalls, 0);
});

runner.test('list - Agent 列表查询', async () => {
  await store.saveInfo('agt-list001', {
    agentId: 'agt-list001',
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: {}
  });

  await store.saveInfo('agt-list002', {
    agentId: 'agt-list002',
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

  const prefixedAgents = await store.list('agt-list');
  expect.toBeGreaterThanOrEqual(prefixedAgents.length, 2);
});

// ========== 5.1.9 测试高级功能 (ExtendedStore) ==========

runner.test('healthCheck - 健康检查', async () => {
  const health = await store.healthCheck();

  expect.toBeTruthy(health.healthy, '应该返回健康状态');
  expect.toEqual(health.database.connected, true, '数据库应该已连接');
  expect.toBeTruthy(typeof health.database.latencyMs === 'number', '应该返回延迟时间');
  expect.toEqual(health.fileSystem.writable, true, '文件系统应该可写');
  expect.toBeTruthy(health.checkedAt > 0, '应该返回检查时间');
});

runner.test('checkConsistency - 一致性检查', async () => {
  const agentId = 'agt-consistency001';

  // 创建 Agent
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

  const result = await store.checkConsistency(agentId);

  expect.toEqual(result.consistent, true, '新创建的 Agent 应该一致');
  expect.toHaveLength(result.issues, 0);
  expect.toBeTruthy(result.checkedAt > 0);
});

runner.test('checkConsistency - 检测不存在的 Agent', async () => {
  const result = await store.checkConsistency('agt-nonexistent');

  expect.toEqual(result.consistent, false);
  expect.toBeGreaterThanOrEqual(result.issues.length, 1);
});

runner.test('getMetrics - 获取指标统计', async () => {
  const metrics = await store.getMetrics();

  expect.toBeTruthy(typeof metrics.operations.saves === 'number');
  expect.toBeTruthy(typeof metrics.operations.loads === 'number');
  expect.toBeTruthy(typeof metrics.storage.totalAgents === 'number');
  expect.toBeTruthy(typeof metrics.storage.totalMessages === 'number');
  expect.toBeTruthy(metrics.collectedAt > 0);
});

runner.test('acquireAgentLock - 获取和释放锁', async () => {
  const agentId = 'agt-lock001';

  // 获取锁
  const releaseLock = await store.acquireAgentLock(agentId, 5000);
  expect.toBeTruthy(typeof releaseLock === 'function', '应该返回释放函数');

  // 释放锁
  await releaseLock();
});

runner.test('acquireAgentLock - 重复获取锁应失败', async () => {
  const agentId = 'agt-lock002';

  // 获取第一个锁
  const releaseLock1 = await store.acquireAgentLock(agentId, 5000);

  // 尝试获取第二个锁应该失败
  let errorThrown = false;
  try {
    await store.acquireAgentLock(agentId, 1000);
  } catch (error) {
    errorThrown = true;
  }

  expect.toEqual(errorThrown, true, '重复获取锁应该抛出错误');

  // 释放第一个锁
  await releaseLock1();
});

runner.test('batchFork - 批量 Fork Agent', async () => {
  const sourceAgentId = 'agt-fork-source';

  // 创建源 Agent
  await store.saveInfo(sourceAgentId, {
    agentId: sourceAgentId,
    templateId: 'test-template',
    createdAt: new Date().toISOString(),
    configVersion: 'v2.7.0',
    lineage: [],
    messageCount: 0,
    lastSfpIndex: -1,
    metadata: { source: true }
  });

  await store.saveMessages(sourceAgentId, [
    { role: 'user', content: [{ type: 'text', text: 'Fork test' }] }
  ]);

  // 批量 Fork
  const newAgentIds = await store.batchFork(sourceAgentId, 3);

  expect.toHaveLength(newAgentIds, 3);

  // 验证每个新 Agent
  for (const newAgentId of newAgentIds) {
    expect.toBeTruthy(newAgentId.startsWith('agt-'), 'ID 应该以 agt- 开头');

    const exists = await store.exists(newAgentId);
    expect.toEqual(exists, true, '新 Agent 应该存在');

    const info = await store.loadInfo(newAgentId);
    expect.toBeTruthy(info, '应该能加载 Info');
    expect.toBeTruthy(info!.lineage.includes(sourceAgentId), 'lineage 应该包含源 Agent');

    const messages = await store.loadMessages(newAgentId);
    expect.toHaveLength(messages, 1);
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
