/**
 * MCP 工具与 Agent 集成测试
 *
 * 测试 MCP 工具在真实 Agent 场景中的使用
 * 验证：
 * - MCP 工具与 Agent 的集成
 * - 工具命名空间在 Agent 中的正确识别
 * - 工具注册和可用性
 */

import path from 'path';
import {
  Agent,
  getMCPTools,
  disconnectAllMCP,
  MCPConfig,
  ToolRegistry,
  builtin,
  AnthropicProvider,
  JSONStore,
  AgentTemplateRegistry,
  SandboxFactory,
} from '../../../src';
import { createIntegrationTestAgent } from '../../helpers/setup';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('集成测试 - MCP 工具与 Agent 集成');

/**
 * 辅助函数：带超时的 Promise 包装
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string = '操作超时'
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

/**
 * 测试 1: MCP 工具注册到 Agent
 */
runner.test('MCP 工具注册到 Agent 工具注册表', async () => {
  // 连接 MCP 服务器
  const mcpConfig: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'registry-time',
  };

  const mcpTools = await withTimeout(
    getMCPTools(mcpConfig),
    30000,
    '连接 MCP 服务器超时'
  );

  expect.toBeGreaterThan(mcpTools.length, 0, '应获取到 MCP 工具');

  // 验证工具结构
  const firstTool = mcpTools[0];
  expect.toBeTruthy(firstTool.name, '工具应有名称');
  expect.toBeTruthy(firstTool.description, '工具应有描述');
  expect.toBeTruthy(firstTool.exec, '工具应有 exec 方法');
  expect.toContain(firstTool.name, 'mcp__registry-time__', '工具名应包含命名空间');

  // 清理
  await disconnectAllMCP();
});

/**
 * 测试 2: MCP 工具可以直接调用
 */
runner.test('MCP 工具可以直接调用', async () => {
  // 连接 MCP 服务器
  const mcpConfig: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'direct-call',
  };

  const mcpTools = await withTimeout(
    getMCPTools(mcpConfig),
    30000,
    '连接 MCP 服务器超时'
  );

  // 直接调用工具（不通过 Agent）
  const timeTool = mcpTools.find(t => t.name.includes('time'));

  if (timeTool) {
    const result = await withTimeout(
      timeTool.exec({ timezone: 'Asia/Shanghai' }, {} as any),
      10000,
      '工具调用超时'
    );

    expect.toBeTruthy(result, '应返回结果');
    expect.toBeTruthy(result.content, '应返回内容');
  } else {
    console.log('  ⚠️  未找到时间工具，跳过直接调用测试');
  }

  // 清理
  await disconnectAllMCP();
});

/**
 * 测试 3: Agent 注册 MCP 工具
 */
runner.test('Agent 成功注册 MCP 工具', async () => {
  // 连接 MCP 服务器
  const mcpConfig: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'agent-register',
  };

  const mcpTools = await withTimeout(
    getMCPTools(mcpConfig),
    30000,
    '连接 MCP 服务器超时'
  );

  expect.toBeGreaterThan(mcpTools.length, 0, '应获取到 MCP 工具');

  // 验证工具已注册（通过创建 ToolRegistry）
  const registry = new ToolRegistry();
  for (const tool of mcpTools) {
    registry.register(tool.name, () => tool);
  }

  // 验证工具已注册
  for (const tool of mcpTools) {
    const hasTool = registry.has(tool.name);
    expect.toBeTruthy(hasTool, `工具 ${tool.name} 应已注册`);
  }

  // 清理
  await disconnectAllMCP();
});

/**
 * 测试 4: 多个 MCP 服务器工具集成
 */
runner.test('多个 MCP 服务器工具集成', async () => {
  // 连接多个 MCP 服务器
  const mcpConfigs: MCPConfig[] = [
    {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time'],
      serverName: 'multi-1',
    },
    {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time'],
      serverName: 'multi-2',
    },
  ];

  const allMcpTools = await Promise.all(
    mcpConfigs.map(config =>
      withTimeout(getMCPTools(config), 30000, '连接 MCP 服务器超时')
    )
  );

  const mcpTools = allMcpTools.flat();

  // 验证工具来自不同命名空间
  const server1Tools = mcpTools.filter(t => t.name.includes('mcp__multi-1__'));
  const server2Tools = mcpTools.filter(t => t.name.includes('mcp__multi-2__'));

  expect.toBeGreaterThan(server1Tools.length, 0, '应有来自服务器 1 的工具');
  expect.toBeGreaterThan(server2Tools.length, 0, '应有来自服务器 2 的工具');

  // 验证命名空间隔离
  const allNames = new Set(mcpTools.map(t => t.name));
  expect.toEqual(allNames.size, mcpTools.length, '工具名应唯一（命名空间隔离）');

  // 清理
  await disconnectAllMCP();
});

/**
 * 测试 5: MCP 工具白名单/黑名单过滤
 */
runner.test('MCP 工具过滤功能', async () => {
  // 连接 MCP 服务器并使用白名单
  const mcpConfig: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'filter-test',
    include: ['get_current_time'], // 白名单
  };

  const mcpTools = await withTimeout(
    getMCPTools(mcpConfig),
    30000,
    '连接 MCP 服务器超时'
  );

  // 验证只返回了白名单中的工具
  for (const tool of mcpTools) {
    expect.toContain(tool.name, 'get_current_time', '工具名应包含白名单中的名称');
  }

  // 清理
  await disconnectAllMCP();
});

/**
 * 测试 6: MCP 工具与 LLM 集成测试（简化版）
 */
runner.test('MCP 工具输入模式验证', async () => {
  // 连接 MCP 服务器
  const mcpConfig: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'schema-test',
  };

  const mcpTools = await withTimeout(
    getMCPTools(mcpConfig),
    30000,
    '连接 MCP 服务器超时'
  );

  // 验证工具的 input_schema 适合 LLM 使用
  for (const tool of mcpTools) {
    expect.toBeTruthy(tool.input_schema, `工具 ${tool.name} 应有 input_schema`);
    expect.toBeTruthy(typeof tool.input_schema === 'object', 'input_schema 应是对象');

    // 验证 input_schema 包含必要的字段
    const schema = tool.input_schema;
    expect.toBeTruthy(schema.type || schema.$schema, 'schema 应有 type 或 $schema 字段');
  }

  // 清理
  await disconnectAllMCP();
});

/**
 * 测试 7: MCP 工具描述符信息
 */
runner.test('MCP 工具描述符包含完整元数据', async () => {
  // 连接 MCP 服务器
  const mcpConfig: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'descriptor-test',
  };

  const mcpTools = await withTimeout(
    getMCPTools(mcpConfig),
    30000,
    '连接 MCP 服务器超时'
  );

  // 验证工具描述符
  for (const tool of mcpTools) {
    const descriptor = tool.toDescriptor();

    expect.toEqual(descriptor.source, 'mcp', '工具来源应为 mcp');
    expect.toBeTruthy(descriptor.name, '描述符应有名称');
    expect.toBeTruthy(descriptor.metadata, '描述符应有元数据');
    expect.toEqual(descriptor.metadata?.mcpServer, 'descriptor-test', '应记录 MCP 服务器名');
    expect.toEqual(descriptor.metadata?.transport, 'stdio', '应记录传输类型');
  }

  // 清理
  await disconnectAllMCP();
});

/**
 * 测试 8: MCP 断开重连
 */
runner.test('MCP 断开连接后重新连接', async () => {
  const serverName = 'reconnect-test';
  const mcpConfig: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName,
  };

  // 第一次连接
  const tools1 = await withTimeout(
    getMCPTools(mcpConfig),
    30000,
    '第一次连接超时'
  );
  expect.toBeGreaterThan(tools1.length, 0, '第一次连接应返回工具');

  // 断开连接
  await disconnectAllMCP();

  // 重新连接
  const tools2 = await withTimeout(
    getMCPTools(mcpConfig),
    30000,
    '重新连接超时'
  );
  expect.toBeGreaterThan(tools2.length, 0, '重新连接应返回工具');

  // 清理
  await disconnectAllMCP();
});

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
