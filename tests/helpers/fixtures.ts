/**
 * 测试固件和配置
 */

import path from 'path';
import fs from 'fs';

const ENV_PATH = process.env.KODE_SDK_TEST_ENV_PATH
  ? path.resolve(process.cwd(), process.env.KODE_SDK_TEST_ENV_PATH)
  : path.resolve(__dirname, '../../.env.test');

function parseEnvFile(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const env: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

/**
 * 测试数据根目录
 */
export const TEST_ROOT = path.join(process.cwd(), 'tests', '.tmp');

/**
 * 集成测试配置
 */
export interface IntegrationConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * 加载集成测试配置
 */
export function loadIntegrationConfig(): IntegrationConfig {
  let envConfig: Record<string, string> = {};

  if (fs.existsSync(ENV_PATH)) {
    envConfig = parseEnvFile(ENV_PATH);
  }

  const get = (key: string): string | undefined => {
    return process.env[key] ?? envConfig[key];
  };

  const baseUrl = get('KODE_SDK_TEST_PROVIDER_BASE_URL');
  const apiKey = get('KODE_SDK_TEST_PROVIDER_API_KEY');
  const model = get('KODE_SDK_TEST_PROVIDER_MODEL');

  if (!baseUrl || !apiKey || !model) {
    const hint = [
      `未找到完整的集成测试配置.`,
      `请在项目根目录创建 .env.test，内容示例：\n`,
      'KODE_SDK_TEST_PROVIDER_BASE_URL=https://api.moonshot.cn/anthropic',
      'KODE_SDK_TEST_PROVIDER_API_KEY=your-api-key',
      'KODE_SDK_TEST_PROVIDER_MODEL=kimi-k2-turbo-preview',
      '',
      `如需自定义路径，可设置环境变量 KODE_SDK_TEST_ENV_PATH 指向配置文件。`
    ].join('\n');
    throw new Error(hint);
  }

  return { baseUrl, apiKey, model };
}

/**
 * 模板固件
 */
export const TEMPLATES = {
  basic: {
    id: 'test-basic',
    systemPrompt: 'You are a unit test agent.',
    tools: ['fs_read', 'fs_write'],
    permission: { mode: 'auto' as const },
  },
  fullFeatured: {
    id: 'test-full',
     systemPrompt: 'You are a fully featured test agent.',
    tools: [
      'fs_read', 'fs_write', 'fs_edit', 'fs_glob', 'fs_grep', 'fs_multi_edit',
      'bash_run', 'bash_logs', 'bash_kill',
      'todo_read', 'todo_write',
    ],
    runtime: {
      todo: { enabled: true, remindIntervalSteps: 10, reminderOnStart: false },
    },
  },
  withApproval: {
    id: 'test-approval',
    systemPrompt: 'You require approval to mutate.',
    tools: ['fs_write', 'bash_run'],
    permission: { mode: 'approval' as const },
  },
  readonly: {
    id: 'test-readonly',
    systemPrompt: 'You are readonly.',
    tools: ['fs_read', 'fs_glob', 'fs_grep'],
    permission: { mode: 'readonly' as const },
  },
  withHooks: {
    id: 'test-hooks',
    systemPrompt: 'You enforce hooks.',
    tools: ['fs_read', 'fs_write'],
    hooks: {
      preToolUse: (call: any) => {
        if (call.args?.path?.includes('blocked')) {
          return { decision: 'deny', reason: 'Path blocked' };
        }
      },
    },
  },
};

/**
 * Mock响应固件
 */
export const MOCK_RESPONSES = {
  simple: ['Simple response'],
  multiTurn: ['First response', 'Second response', 'Third response'],
  withTool: ['<tool>fs_read</tool>'],
  empty: [''],
};
