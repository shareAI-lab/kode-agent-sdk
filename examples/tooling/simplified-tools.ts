/**
 * 简化工具定义示例 - 展示新的 defineTool API
 *
 * 本示例展示三种定义工具的方式：
 * 1. defineTool - 函数式定义（推荐）
 * 2. defineTools - 批量定义
 * 3. @toolDecorator 装饰器 + extractTools（实验性）
 */

import '../shared/load-env';

import {
  Agent,
  defineTool,
  defineTools,
  toolDecorator,
  extractTools,
  EnhancedToolContext,
} from '@shareai-lab/kode-sdk';
import { createRuntime } from '../shared/runtime';

// ============================================
// 方式 1: 函数式定义（推荐）
// ============================================

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get weather information for a city',

  // 自动生成 JSON Schema - 不再需要手动写！
  params: {
    city: {
      type: 'string',
      description: 'City name',
    },
    units: {
      type: 'string',
      description: 'Temperature units',
      enum: ['celsius', 'fahrenheit'],
      required: false,
      default: 'celsius',
    },
  },

  // 简化的属性标记
  attributes: {
    readonly: true,  // 只读工具
    noEffect: true,  // 无副作用，可安全重试
  },

  prompt: 'Use this tool to fetch current weather. Always specify the city name clearly.',

  async exec(args: { city: string; units?: string }, ctx: EnhancedToolContext) {
    const weather = {
      city: args.city,
      temperature: 22,
      condition: 'sunny',
      units: args.units || 'celsius',
    };

    // 发射自定义事件！
    ctx.emit('weather_fetched', {
      city: args.city,
      timestamp: Date.now(),
    });

    return weather;
  },
});

// ============================================
// 方式 2: 批量定义
// ============================================

const calculatorTools = defineTools([
  {
    name: 'add',
    description: 'Add two numbers',
    params: {
      a: { type: 'number', description: 'First number' },
      b: { type: 'number', description: 'Second number' },
    },
    attributes: { readonly: true, noEffect: true },
    async exec(args, ctx: EnhancedToolContext) {
      const result = args.a + args.b;
      ctx.emit('calculation', { operation: 'add', result });
      return result;
    },
  },
  {
    name: 'multiply',
    description: 'Multiply two numbers',
    params: {
      a: { type: 'number', description: 'First number' },
      b: { type: 'number', description: 'Second number' },
    },
    attributes: { readonly: true, noEffect: true },
    async exec(args, ctx: EnhancedToolContext) {
      const result = args.a * args.b;
      ctx.emit('calculation', { operation: 'multiply', result });
      return result;
    },
  },
]);

// ============================================
// 方式 3: 装饰器（实验性 - 需要 experimentalDecorators）
// ============================================

class DatabaseTools {
  @toolDecorator({
    description: 'Query database',
    params: {
      sql: { type: 'string', description: 'SQL query' },
      limit: { type: 'number', description: 'Result limit', required: false, default: 100 },
    },
    attributes: { readonly: true },  // 只读查询
    prompt: 'Use this tool to query the database. Always validate SQL before execution.',
  })
  async query(args: { sql: string; limit?: number }, ctx: EnhancedToolContext) {
    // 模拟查询
    const results = [{ id: 1, name: 'Example' }];

    ctx.emit('db_query', {
      sql: args.sql,
      rowCount: results.length,
    });

    return { results, count: results.length };
  }

  @toolDecorator({
    description: 'Insert data into database',
    params: {
      table: { type: 'string', description: 'Table name' },
      data: { type: 'object', description: 'Data to insert' },
    },
    // 默认为写入工具（不设置 attributes）
    prompt: 'Use this tool to insert data. Always validate input before insertion.',
  })
  async insert(args: { table: string; data: any }, ctx: EnhancedToolContext) {
    // 模拟插入
    const id = Math.random().toString(36).slice(2);

    ctx.emit('db_insert', {
      table: args.table,
      id,
    });

    return { id, inserted: true };
  }
}

// ============================================
// 复杂参数示例：嵌套对象和数组
// ============================================

const createUserTool = defineTool({
  name: 'create_user',
  description: 'Create a new user with profile',

  params: {
    username: { type: 'string', description: 'Username' },
    profile: {
      type: 'object',
      description: 'User profile',
      properties: {
        email: { type: 'string', description: 'Email address' },
        age: { type: 'number', description: 'Age', required: false },
        tags: {
          type: 'array',
          description: 'User tags',
          items: { type: 'string' },
          required: false,
        },
      },
    },
  },

  async exec(args, ctx: EnhancedToolContext) {
    const userId = Math.random().toString(36).slice(2);

    ctx.emit('user_created', {
      userId,
      username: args.username,
      timestamp: Date.now(),
    });

    return {
      userId,
      username: args.username,
      profile: args.profile,
    };
  },
});

// ============================================
// 使用示例
// ============================================

async function main() {
  const customTools = [
    weatherTool,
    ...calculatorTools,
    ...extractTools(new DatabaseTools()),
    createUserTool,
  ];
  const modelId = process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-5-20250929';

  const deps = createRuntime(({ templates, registerBuiltin, tools }) => {
    registerBuiltin('todo');

    for (const toolInstance of customTools) {
      tools.register(toolInstance.name, () => toolInstance);
    }

    templates.register({
      id: 'demo-tools',
      systemPrompt: 'You are a tool demonstrator. Always leverage the registered tools when appropriate.',
      tools: customTools.map((tool) => tool.name),
      model: modelId,
      runtime: { todo: { enabled: false } },
    });
  });

  const agent = await Agent.create(
    {
      templateId: 'demo-tools',
      sandbox: { kind: 'local', workDir: './workspace', enforceBoundary: true },
    },
    deps
  );

  agent.on('tool_custom_event', (event) => {
    console.log(`[Custom Event] ${event.toolName}.${event.eventType}:`, event.data);
  });

  await agent.chat('What is the weather in Tokyo?');
  await agent.chat('Calculate 123 + 456');
  await agent.chat('Query all users from database');
}

// ============================================
// 对比：老方式 vs 新方式
// ============================================

// 老方式 - 手动写 schema，麻烦
const oldStyleTool = {
  name: 'greet',
  description: 'Greet a person',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Person name' },
      formal: { type: 'boolean', description: 'Use formal greeting' },
    },
    required: ['name'],
  },
  async exec(args: any, ctx: any) {
    return `Hello ${args.name}`;
  },
  toDescriptor() {
    return { source: 'registered', name: 'greet', registryId: 'greet' } as any;
  },
};

// 新方式 - 自动生成 schema + 简化属性 + 自定义事件
const newStyleTool = defineTool({
  name: 'greet',
  description: 'Greet a person',
  params: {
    name: { type: 'string', description: 'Person name' },
    formal: { type: 'boolean', description: 'Use formal greeting', required: false },
  },
  attributes: { readonly: true, noEffect: true },
  async exec(args, ctx: EnhancedToolContext) {
    ctx.emit('greeting_sent', { name: args.name });
    return `Hello ${args.name}`;
  },
});

if (require.main === module) {
  main().catch(console.error);
}
