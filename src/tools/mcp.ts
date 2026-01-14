import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { ToolInstance, ToolDescriptor } from './registry';
import type { ToolContext } from '../core/types';
import { globalToolRegistry } from './registry';

/**
 * MCP Transport 类型
 */
export type MCPTransportType = 'stdio' | 'sse' | 'http';

/**
 * MCP 连接配置
 */
export interface MCPConfig {
  /**
   * 传输类型
   */
  transport: MCPTransportType;

  /**
   * Stdio transport: 命令和参数
   */
  command?: string;
  args?: string[];
  env?: Record<string, string>;

  /**
   * HTTP/SSE transport: URL
   */
  url?: string;

  /**
   * Server 名称（用于命名空间）
   */
  serverName?: string;

  /**
   * 包含的工具（白名单，不提供则全部包含）
   */
  include?: string[];

  /**
   * 排除的工具（黑名单）
   */
  exclude?: string[];
}

/**
 * MCP Client 管理器
 *
 * 维护 MCP 客户端连接，支持多种传输方式
 */
class MCPClientManager {
  private clients = new Map<string, Client>();
  private transports = new Map<string, any>();

  async connect(serverName: string, config: MCPConfig): Promise<Client> {
    // 如果已连接，返回现有客户端
    if (this.clients.has(serverName)) {
      return this.clients.get(serverName)!;
    }

    // 创建 transport
    let transport: any;
    if (config.transport === 'stdio') {
      if (!config.command) {
        throw new Error('command is required for stdio transport');
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: config.env,
      });
    } else if (config.transport === 'sse' || config.transport === 'http') {
      if (!config.url) {
        throw new Error('url is required for sse/http transport');
      }
      transport = new SSEClientTransport(new URL(config.url));
    } else {
      throw new Error(`Unsupported transport type: ${config.transport}`);
    }

    // 创建客户端
    const client = new Client(
      {
        name: 'kode-sdk',
        version: '2.0.0',
      },
      {
        capabilities: {},
      }
    );

    // 连接
    await client.connect(transport);

    // 缓存
    this.clients.set(serverName, client);
    this.transports.set(serverName, transport);

    return client;
  }

  async disconnect(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      await client.close();
      this.clients.delete(serverName);
    }

    const transport = this.transports.get(serverName);
    if (transport) {
      await transport.close();
      this.transports.delete(serverName);
    }
  }

  async disconnectAll(): Promise<void> {
    const servers = Array.from(this.clients.keys());
    await Promise.all(servers.map((name) => this.disconnect(name)));
  }

  getClient(serverName: string): Client | undefined {
    return this.clients.get(serverName);
  }
}

const mcpManager = new MCPClientManager();

/**
 * 获取 MCP 工具
 *
 * 连接到 MCP 服务器并将其工具转换为 ToolInstance[]
 *
 * @example
 * ```ts
 * // Stdio transport
 * const tools = await getMCPTools({
 *   transport: 'stdio',
 *   command: 'uvx',
 *   args: ['mcp-server-git'],
 *   serverName: 'git'
 * });
 *
 * // HTTP/SSE transport
 * const tools = await getMCPTools({
 *   transport: 'sse',
 *   url: 'http://localhost:3000/mcp',
 *   serverName: 'company',
 *   include: ['search', 'summarize']
 * });
 * ```
 */
export async function getMCPTools(config: MCPConfig): Promise<ToolInstance[]> {
  const serverName = config.serverName || 'default';

  // 连接到 MCP 服务器
  const client = await mcpManager.connect(serverName, config);

  // 列出可用工具
  const toolsResponse = await client.listTools();
  const mcpTools = toolsResponse.tools;

  // 过滤工具
  let filtered = mcpTools;
  if (config.include) {
    filtered = filtered.filter((tool) => config.include!.includes(tool.name));
  }
  if (config.exclude) {
    filtered = filtered.filter((tool) => !config.exclude!.includes(tool.name));
  }

  // 转换为 ToolInstance[]
  const toolInstances: ToolInstance[] = filtered.map((mcpTool) => {
    // 生成命名空间化的工具名：mcp__serverName__toolName
    const toolName = `mcp__${serverName}__${mcpTool.name}`;

    const toolInstance: ToolInstance = {
      name: toolName,
      description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
      input_schema: mcpTool.inputSchema as any,

      async exec(args: any, _ctx: ToolContext): Promise<any> {
        try {
          // 调用 MCP 工具
          const result = await client.callTool({
            name: mcpTool.name,
            arguments: args,
          });

          // 返回结果
          return {
            content: result.content,
            isError: result.isError,
          };
        } catch (error) {
          throw new Error(`MCP tool execution failed: ${error}`);
        }
      },

      toDescriptor(): ToolDescriptor {
        return {
          source: 'mcp',
          name: toolName,
          registryId: toolName,
          metadata: {
            mcpServer: serverName,
            mcpToolName: mcpTool.name,
            transport: config.transport,
          },
          config: {
            serverName,
            transport: config.transport,
            url: config.url,
            command: config.command,
            args: config.args,
          },
        };
      },
    };

    // 自动注册到 global registry（支持 Resume）
    globalToolRegistry.register(toolName, (_registryConfig) => {
      // Resume 时重建 MCP 连接
      return toolInstance;
    });

    return toolInstance;
  });

  return toolInstances;
}

/**
 * 断开 MCP 服务器连接
 */
export async function disconnectMCP(serverName: string): Promise<void> {
  await mcpManager.disconnect(serverName);
}

/**
 * 断开所有 MCP 服务器连接
 */
export async function disconnectAllMCP(): Promise<void> {
  await mcpManager.disconnectAll();
}