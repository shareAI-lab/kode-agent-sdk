import { z, ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { globalToolRegistry, ToolInstance, ToolDescriptor } from './registry';
import { ToolContext } from '../core/types';
import { Hooks } from '../core/hooks';

/**
 * 工具定义接口
 */
export interface ToolDefinition<TArgs = any, TResult = any> {
  name: string;
  description?: string;
  parameters?: ZodType<TArgs>;
  execute: (args: TArgs, ctx: EnhancedToolContext) => Promise<TResult> | TResult;
  metadata?: {
    version?: string;
    tags?: string[];
    cacheable?: boolean;
    cacheTTL?: number;
    timeout?: number;
    concurrent?: boolean;
    readonly?: boolean;
  };
  hooks?: Hooks;
}

/**
 * 工具上下文增强接口
 */
export interface EnhancedToolContext extends ToolContext {
  emit(eventType: string, data?: any): void;
}

/**
 * 重载 1: tool(name, executeFn)
 * 零配置模式，自动推断类型
 */
export function tool<TArgs = any, TResult = any>(
  name: string,
  executeFn: (args: TArgs, ctx?: EnhancedToolContext) => Promise<TResult> | TResult
): ToolInstance;

/**
 * 重载 2: tool(definition)
 * 完整配置模式
 */
export function tool<TArgs = any, TResult = any>(
  definition: ToolDefinition<TArgs, TResult>
): ToolInstance;

/**
 * 实现
 */
export function tool<TArgs = any, TResult = any>(
  nameOrDef: string | ToolDefinition<TArgs, TResult>,
  executeFn?: (args: TArgs, ctx?: EnhancedToolContext) => Promise<TResult> | TResult
): ToolInstance {
  // 解析参数
  const def: ToolDefinition<TArgs, TResult> =
    typeof nameOrDef === 'string'
      ? {
          name: nameOrDef,
          description: `Execute ${nameOrDef}`,
          parameters: z.any() as ZodType<TArgs>,
          execute: executeFn!,
        }
      : nameOrDef;

  // 生成 JSON Schema
  const input_schema = def.parameters
    ? zodToJsonSchema(def.parameters as any, { target: 'openApi3', $refStrategy: 'none' })
    : { type: 'object', properties: {} };

  // 创建工具实例
  const toolInstance: ToolInstance = {
    name: def.name,
    description: def.description || `Execute ${def.name}`,
    input_schema,
    hooks: def.hooks,

    async exec(args: any, ctx: ToolContext): Promise<any> {
      try {
        // 参数验证
        if (def.parameters) {
          const parseResult = def.parameters.safeParse(args);
          if (!parseResult.success) {
            return {
              ok: false,
              error: `Invalid parameters: ${parseResult.error.message}`,
              _validationError: true,
            };
          }
          args = parseResult.data;
        }

        // 增强上下文
        const enhancedCtx: EnhancedToolContext = {
          ...ctx,
          emit(eventType: string, data?: any) {
            ctx.agent?.events?.emitMonitor({
              type: 'tool_custom_event' as any,
              toolName: def.name,
              eventType,
              data,
              timestamp: Date.now(),
            } as any);
          },
        };

        // 执行工具
        const result = await def.execute(args, enhancedCtx);

        // 如果工具返回 {ok: false}，保持原样
        if (result && typeof result === 'object' && 'ok' in result && (result as any).ok === false) {
          return result;
        }

        // 正常结果
        return result;
      } catch (error: any) {
        // 捕获工具执行中的所有错误，统一返回格式
        return {
          ok: false,
          error: error?.message || String(error),
          _thrownError: true,
        };
      }
    },

    toDescriptor(): ToolDescriptor {
      return {
        source: 'registered',
        name: def.name,
        registryId: def.name,
        metadata: {
          version: def.metadata?.version,
          tags: def.metadata?.tags,
          cacheable: def.metadata?.cacheable,
          cacheTTL: def.metadata?.cacheTTL,
          timeout: def.metadata?.timeout,
          concurrent: def.metadata?.concurrent,
          access: def.metadata?.readonly ? 'read' : 'write',
          mutates: !def.metadata?.readonly,
        },
      };
    },
  };

  // 自动注册到全局 registry
  globalToolRegistry.register(def.name, () => toolInstance);

  return toolInstance;
}

/**
 * 批量定义工具
 */
export function tools(definitions: ToolDefinition[]): ToolInstance[] {
  return definitions.map((def) => tool(def));
}
