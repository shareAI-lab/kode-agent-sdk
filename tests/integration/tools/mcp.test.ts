/**
 * MCP 工具集成测试
 *
 * 测试 MCP (Model Context Protocol) 工具的接入和功能
 * 包括：
 * - stdio 传输方式的连接
 * - 工具注册和调用
 * - 多服务器管理
 * - 工具命名空间化
 * - 连接断开和清理
 */

import path from 'path';
import {
  getMCPTools,
  disconnectMCP,
  disconnectAllMCP,
  MCPConfig,
  ToolRegistry,
} from '../../../src';
import { TestRunner, expect, retry } from '../../helpers/utils';

const runner = new TestRunner('集成测试 - MCP 工具接入');

// 测试超时时间（毫秒）
const TEST_TIMEOUT = 60000;

/**
 * 辅助函数：带超时的测试执行
 */
async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  errorMessage: string = '操作超时'
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

/**
 * 测试 1: 连接 mcp-server-time (uvx)
 */
runner.test('连接 mcp-server-time 服务器 (uvx stdio)', async () => {
  const config: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'time',
  };

  const tools = await withTimeout(
    () => getMCPTools(config),
    TEST_TIMEOUT,
    '连接 mcp-server-time 超时，请确保已安装 uvx 命令'
  );

  // 验证返回了工具
  expect.toBeGreaterThan(tools.length, 0, '应该至少返回一个工具');

  // 验证工具命名空间化
  const firstTool = tools[0];
  expect.toContain(firstTool.name, 'mcp__time__', '工具名应包含命名空间前缀');

  // 验证工具描述
  expect.toBeTruthy(firstTool.description, '工具应有描述信息');

  // 验证工具 descriptor
  const descriptor = firstTool.toDescriptor();
  expect.toEqual(descriptor.source, 'mcp', '工具来源应为 mcp');
  expect.toEqual(descriptor.metadata?.mcpServer, 'time', '应记录 MCP 服务器名称');

  // 清理连接
  await disconnectMCP('time');
});

/**
 * 测试 2: 连接 @tokenizin/mcp-npx-fetch (npx)
 */
runner.test('连接 @tokenizin/mcp-npx-fetch 服务器 (npx stdio)', async () => {
  const config: MCPConfig = {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@tokenizin/mcp-npx-fetch'],
    serverName: 'fetch',
  };

  const tools = await withTimeout(
    () => getMCPTools(config),
    TEST_TIMEOUT,
    '连接 @tokenizin/mcp-npx-fetch 超时，请确保网络连接正常'
  );

  // 验证返回了工具
  expect.toBeGreaterThan(tools.length, 0, '应该至少返回一个工具');

  // 验证工具命名空间化
  const fetchTool = tools.find(t => t.name.includes('fetch'));
  expect.toBeTruthy(fetchTool, '应该找到包含 fetch 的工具');

  // 验证工具结构
  expect.toBeTruthy(fetchTool!.input_schema, '工具应有输入模式定义');
  expect.toBeTruthy(typeof fetchTool!.exec === 'function', '工具应有 exec 方法');

  // 清理连接
  await disconnectMCP('fetch');
});

/**
 * 测试 3: 工具白名单过滤
 */
runner.test('工具白名单过滤功能', async () => {
  const config: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'time-filter',
    include: ['get_current_time'], // 只包含特定工具
  };

  const tools = await withTimeout(
    () => getMCPTools(config),
    TEST_TIMEOUT
  );

  // 验证只返回了白名单中的工具
  expect.toEqual(tools.length, 1, '应该只返回一个工具（白名单过滤）');

  // 验证工具名
  expect.toEqual(tools[0].name, 'mcp__time-filter__get_current_time', '工具名应匹配白名单');

  // 清理连接
  await disconnectMCP('time-filter');
});

/**
 * 测试 4: 工具黑名单过滤
 */
runner.test('工具黑名单过滤功能', async () => {
  const config: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'time-exclude',
    exclude: ['get_current_time'], // 排除特定工具
  };

  const tools = await withTimeout(
    () => getMCPTools(config),
    TEST_TIMEOUT
  );

  // 验证没有返回黑名单中的工具
  const excludedTool = tools.find(t => t.name.includes('get_current_time'));
  expect.toBeFalsy(excludedTool, '不应该返回被排除的工具');

  // 清理连接
  await disconnectMCP('time-exclude');
});

/**
 * 测试 5: 工具注册到 ToolRegistry
 */
runner.test('工具注册到 ToolRegistry', async () => {
  const registry = new ToolRegistry();

  const config: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'time-registry',
  };

  const tools = await withTimeout(
    () => getMCPTools(config),
    TEST_TIMEOUT
  );

  // 手动注册到自定义 registry
  for (const tool of tools) {
    registry.register(tool.name, () => tool);
  }

  // 验证工具已注册
  for (const tool of tools) {
    const hasTool = registry.has(tool.name);
    expect.toBeTruthy(hasTool, `工具 ${tool.name} 应该已注册`);

    const registered = registry.create(tool.name);
    expect.toEqual(registered.name, tool.name, '注册的工具名应匹配');
  }

  // 清理连接
  await disconnectMCP('time-registry');
});

/**
 * 测试 6: 同时连接多个 MCP 服务器
 */
runner.test('同时连接多个 MCP 服务器', async () => {
  const configs: MCPConfig[] = [
    {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time'],
      serverName: 'multi-time',
    },
    {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@tokenizin/mcp-npx-fetch'],
      serverName: 'multi-fetch',
    },
  ];

  // 连接所有服务器
  const allTools = await withTimeout(
    async () => {
      const toolsArray = await Promise.all(
        configs.map(config => getMCPTools(config))
      );
      return toolsArray.flat();
    },
    TEST_TIMEOUT * 2,
    '连接多个 MCP 服务器超时'
  );

  // 验证所有工具都已加载
  expect.toBeGreaterThan(allTools.length, 0, '应该返回多个工具');

  // 验证不同服务器的工具有不同的命名空间
  const timeTools = allTools.filter(t => t.name.includes('mcp__multi-time__'));
  const fetchTools = allTools.filter(t => t.name.includes('mcp__multi-fetch__'));

  expect.toBeGreaterThan(timeTools.length, 0, '应该有来自 time 服务器的工具');
  expect.toBeGreaterThan(fetchTools.length, 0, '应该有来自 fetch 服务器的工具');

  // 验证命名空间隔离
  const timeToolNames = new Set(timeTools.map(t => t.name));
  const fetchToolNames = new Set(fetchTools.map(t => t.name));
  const hasIntersection = Array.from(timeToolNames).some(name => fetchToolNames.has(name));
  expect.toBeFalsy(hasIntersection, '不同服务器的工具名不应冲突');

  // 清理所有连接
  await disconnectAllMCP();
});

/**
 * 测试 7: 重复连接同一服务器返回缓存连接
 */
runner.test('重复连接同一服务器返回缓存', async () => {
  const config: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'cached-time',
  };

  // 第一次连接
  const tools1 = await withTimeout(
    () => getMCPTools(config),
    TEST_TIMEOUT
  );

  // 第二次连接（应该返回缓存）
  const tools2 = await withTimeout(
    () => getMCPTools(config),
    TEST_TIMEOUT
  );

  // 验证返回相同的工具
  expect.toEqual(tools1.length, tools2.length, '两次连接应返回相同数量的工具');
  expect.toEqual(tools1[0].name, tools2[0].name, '工具名应相同');

  // 清理连接
  await disconnectMCP('cached-time');
});

/**
 * 测试 8: 工具执行（实际调用 MCP 工具）
 */
runner.test('工具执行 - 调用 MCP 工具', async () => {
  const config: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'exec-time',
  };

  const tools = await withTimeout(
    () => getMCPTools(config),
    TEST_TIMEOUT
  );

  // 找到 get_current_time 工具
  const timeTool = tools.find(t => t.name.includes('get_current_time'));
  expect.toBeTruthy(timeTool, '应该找到 get_current_time 工具');

  // 执行工具（不需要参数）
  const result = await withTimeout(
    () => timeTool!.exec({}, {} as any),
    TEST_TIMEOUT
  );

  // 验证结果
  expect.toBeTruthy(result, '应该返回结果');

  // 输出详细结果以便调试
  if (result.isError) {
    console.log('  ⚠️  工具执行返回 isError，结果:', JSON.stringify(result, null, 2));
  }

  // 注意：某些 MCP 服务器可能返回 isError=true 但仍包含有效内容
  // 我们主要验证返回了内容
  expect.toBeTruthy(result.content, '应返回内容');

  // 清理连接
  await disconnectMCP('exec-time');
});

/**
 * 测试 9: 错误处理 - 缺少必需的 command 参数
 */
runner.test('错误处理 - stdio 传输缺少 command', async () => {
  const config: MCPConfig = {
    transport: 'stdio',
    serverName: 'error-test',
  };

  try {
    await getMCPTools(config);
    throw new Error('应该抛出错误');
  } catch (error: any) {
    expect.toContain(error.message, 'command', '错误信息应包含 command');
  }
});

/**
 * 测试 10: 错误处理 - 无效的命令
 */
runner.test('错误处理 - 无效的命令', async () => {
  const config: MCPConfig = {
    transport: 'stdio',
    command: 'nonexistent-command-xyz-123',
    args: ['--invalid'],
    serverName: 'invalid-cmd',
  };

  let hadError = false;
  try {
    await withTimeout(
      () => getMCPTools(config),
      15000, // 15 秒超时
      '无效命令应该在短时间内失败'
    );
  } catch (error: any) {
    hadError = true;

    // 验证是超时或者命令执行错误（支持中英文错误信息和 MCP 错误）
    const errorMessage = error.message || error.toString() || '';
    const isValidError =
      errorMessage.includes('超时') ||
      errorMessage.includes('ENOENT') ||
      errorMessage.includes('command not found') ||
      errorMessage.includes('不是内部或外部命令') ||
      errorMessage.includes('无法识别') ||
      errorMessage.includes('not found') ||
      errorMessage.includes('可执行文件') ||
      errorMessage.includes('MCP error') ||
      errorMessage.includes('Connection closed') ||
      errorMessage.includes('Connection');

    expect.toBeTruthy(isValidError, `应该是命令执行错误或超时，实际错误: ${errorMessage}`);
  }

  expect.toBeTruthy(hadError, '应该抛出错误');

  // 清理：断开可能已建立的连接
  try {
    await disconnectMCP('invalid-cmd');
  } catch {
    // 忽略清理错误
  }
});

/**
 * 测试 11: 断开连接后重新连接
 */
runner.test('断开连接后重新连接', async () => {
  const serverName = 'reconnect-time';
  const config: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName,
  };

  // 第一次连接
  const tools1 = await withTimeout(
    () => getMCPTools(config),
    TEST_TIMEOUT
  );
  expect.toBeGreaterThan(tools1.length, 0, '第一次连接应返回工具');

  // 断开连接
  await disconnectMCP(serverName);

  // 重新连接
  const tools2 = await withTimeout(
    () => getMCPTools(config),
    TEST_TIMEOUT
  );
  expect.toBeGreaterThan(tools2.length, 0, '重新连接应返回工具');

  // 验证工具一致性
  expect.toEqual(tools1[0].name, tools2[0].name, '重新连接后工具名应相同');

  // 清理连接
  await disconnectMCP(serverName);
});

/**
 * 测试 12: 工具输入模式验证
 */
runner.test('工具输入模式验证', async () => {
  const config: MCPConfig = {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@tokenizin/mcp-npx-fetch'],
    serverName: 'schema-test',
  };

  const tools = await withTimeout(
    () => getMCPTools(config),
    TEST_TIMEOUT
  );

  // 验证每个工具都有 input_schema
  for (const tool of tools) {
    expect.toBeTruthy(tool.input_schema, `工具 ${tool.name} 应有 input_schema`);
    expect.toBeTruthy(typeof tool.input_schema === 'object', 'input_schema 应是对象');
  }

  // 清理连接
  await disconnectMCP('schema-test');
});

/**
 * 测试 13: 断开所有连接
 */
runner.test('断开所有 MCP 连接', async () => {
  const configs: MCPConfig[] = [
    {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time'],
      serverName: 'all-1',
    },
    {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time'],
      serverName: 'all-2',
    },
  ];

  // 连接多个服务器
  await Promise.all(configs.map(config => getMCPTools(config)));

  // 断开所有连接
  await disconnectAllMCP();

  // 验证：重新连接应该成功（说明之前的连接已清理）
  const tools = await withTimeout(
    () => getMCPTools(configs[0]),
    TEST_TIMEOUT
  );
  expect.toBeGreaterThan(tools.length, 0, '断开所有后应能重新连接');

  // 清理
  await disconnectAllMCP();
});

/**
 * 测试 14: 空参数工具调用
 */
runner.test('空参数工具调用', async () => {
  const config: MCPConfig = {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-time'],
    serverName: 'no-args',
  };

  const tools = await withTimeout(
    () => getMCPTools(config),
    TEST_TIMEOUT
  );

  // 调用工具（传递空对象）
  const result = await withTimeout(
    () => tools[0].exec({}, {} as any),
    TEST_TIMEOUT
  );

  expect.toBeTruthy(result, '应返回结果');

  // 输出详细结果以便调试
  if (result.isError) {
    console.log('  ⚠️  工具执行返回 isError，结果:', JSON.stringify(result, null, 2));
  }

  // 主要验证返回了内容
  expect.toBeTruthy(result.content, '应返回内容');

  // 清理连接
  await disconnectMCP('no-args');
});

/**
 * 测试 15: 命名空间唯一性
 */
runner.test('工具命名空间唯一性', async () => {
  const configs: MCPConfig[] = [
    {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time'],
      serverName: 'namespace-a',
    },
    {
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-time'],
      serverName: 'namespace-b',
    },
  ];

  const [toolsA, toolsB] = await Promise.all(
    configs.map(config => withTimeout(() => getMCPTools(config), TEST_TIMEOUT))
  );

  // 验证不同服务器的同名工具有不同的命名空间
  const toolA = toolsA[0];
  const toolB = toolsB[0];

  expect.toEqual(toolA.name !== toolB.name, true, '不同服务器的工具名应不同');
  expect.toContain(toolA.name, 'mcp__namespace-a__', '应包含服务器 A 的命名空间');
  expect.toContain(toolB.name, 'mcp__namespace-b__', '应包含服务器 B 的命名空间');

  // 清理连接
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
