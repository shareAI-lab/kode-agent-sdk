import { z, ZodType, ZodTypeAny } from 'zod';

/**
 * TypeScript 类型到 Zod schema 的自动推断
 *
 * 注意：由于 TypeScript 类型在运行时被擦除，我们无法直接从类型生成 schema。
 * 这个模块提供了一些辅助函数来简化 schema 定义。
 */

/**
 * 从示例对象推断 Zod schema
 *
 * @example
 * ```ts
 * const schema = inferFromExample({
 *   name: 'string',
 *   age: 0,
 *   active: true,
 *   tags: ['string']
 * });
 * // 等价于:
 * z.object({
 *   name: z.string(),
 *   age: z.number(),
 *   active: z.boolean(),
 *   tags: z.array(z.string())
 * })
 * ```
 */
export function inferFromExample<T extends Record<string, any>>(
  example: T
): ZodType<any> {
  const shape: Record<string, ZodTypeAny> = {};

  for (const [key, value] of Object.entries(example)) {
    shape[key] = inferValueType(value);
  }

  return z.object(shape);
}

/**
 * 推断单个值的类型
 */
function inferValueType(value: any): ZodTypeAny {
  if (value === null || value === undefined) {
    return z.any();
  }

  const type = typeof value;

  switch (type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'object':
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return z.array(z.any());
        }
        return z.array(inferValueType(value[0]));
      }
      return inferFromExample(value);
    default:
      return z.any();
  }
}

/**
 * Schema 构建器 - 提供流畅的 API
 *
 * @example
 * ```ts
 * const schema = schema()
 *   .string('name', 'User name')
 *   .number('age', 'User age').optional()
 *   .boolean('active').default(true)
 *   .array('tags', z.string())
 *   .build();
 * ```
 */
export class SchemaBuilder {
  private fields: Record<string, ZodTypeAny> = {};

  string(name: string, description?: string): this {
    this.fields[name] = description ? z.string().describe(description) : z.string();
    return this;
  }

  number(name: string, description?: string): this {
    this.fields[name] = description ? z.number().describe(description) : z.number();
    return this;
  }

  boolean(name: string, description?: string): this {
    this.fields[name] = description ? z.boolean().describe(description) : z.boolean();
    return this;
  }

  array(name: string, itemSchema: ZodTypeAny, description?: string): this {
    const schema = z.array(itemSchema);
    this.fields[name] = description ? schema.describe(description) : schema;
    return this;
  }

  object(name: string, shape: Record<string, ZodTypeAny>, description?: string): this {
    const schema = z.object(shape);
    this.fields[name] = description ? schema.describe(description) : schema;
    return this;
  }

  enum(name: string, values: readonly [string, ...string[]], description?: string): this {
    const schema = z.enum(values);
    this.fields[name] = description ? schema.describe(description) : schema;
    return this;
  }

  optional(name: string): this {
    if (this.fields[name]) {
      this.fields[name] = this.fields[name].optional();
    }
    return this;
  }

  default(name: string, defaultValue: any): this {
    if (this.fields[name]) {
      this.fields[name] = this.fields[name].default(defaultValue);
    }
    return this;
  }

  custom(name: string, schema: ZodTypeAny): this {
    this.fields[name] = schema;
    return this;
  }

  build(): ZodType<any> {
    return z.object(this.fields);
  }
}

/**
 * 创建 schema 构建器
 */
export function schema(): SchemaBuilder {
  return new SchemaBuilder();
}

/**
 * 快速定义常用的 schema 模式
 */
export const patterns = {
  /**
   * 文件路径
   */
  filePath: (description = 'File path') =>
    z.string().describe(description),

  /**
   * 目录路径
   */
  dirPath: (description = 'Directory path') =>
    z.string().describe(description),

  /**
   * URL
   */
  url: (description = 'URL') =>
    z.string().url().describe(description),

  /**
   * Email
   */
  email: (description = 'Email address') =>
    z.string().email().describe(description),

  /**
   * 正整数
   */
  positiveInt: (description = 'Positive integer') =>
    z.number().int().positive().describe(description),

  /**
   * 非负整数
   */
  nonNegativeInt: (description = 'Non-negative integer') =>
    z.number().int().nonnegative().describe(description),

  /**
   * 字符串数组
   */
  stringArray: (description = 'Array of strings') =>
    z.array(z.string()).describe(description),

  /**
   * 可选字符串
   */
  optionalString: (description?: string) =>
    z.string().optional().describe(description || 'Optional string'),

  /**
   * 可选数字
   */
  optionalNumber: (description?: string) =>
    z.number().optional().describe(description || 'Optional number'),

  /**
   * JSON 对象
   */
  json: (description = 'JSON object') =>
    z.record(z.string(), z.any()).describe(description),
};

/**
 * 从 JSDoc 注释推断 schema（实验性）
 *
 * 这需要在构建时使用 TypeScript Compiler API 解析
 * 当前仅提供接口，实际实现需要编译时支持
 */
export interface JSDocSchema {
  /**
   * @param name - Parameter name
   * @param type - TypeScript type string (e.g., 'string', 'number', 'Array<string>')
   * @param description - Parameter description
   * @param optional - Whether parameter is optional
   */
  param(name: string, type: string, description?: string, optional?: boolean): this;

  build(): ZodType<any>;
}

/**
 * 辅助函数：合并多个 schema
 */
export function mergeSchemas(...schemas: ZodType<any>[]): ZodType<any> {
  if (schemas.length === 0) {
    return z.object({});
  }

  if (schemas.length === 1) {
    return schemas[0];
  }

  // 使用 z.intersection 合并
  return schemas.reduce((acc, schema) => acc.and(schema));
}

/**
 * 辅助函数：扩展 schema
 */
export function extendSchema<T extends ZodType<any>>(
  base: T,
  extension: Record<string, ZodTypeAny>
): ZodType<any> {
  if (base instanceof z.ZodObject) {
    return base.extend(extension);
  }

  // 如果不是 object schema，创建新的 object schema
  return z.object(extension);
}
