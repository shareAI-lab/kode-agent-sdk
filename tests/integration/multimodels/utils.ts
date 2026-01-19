import fs from 'fs';
import path from 'path';

import {
  Agent,
  AgentConfig,
  AgentDependencies,
  AgentTemplateRegistry,
  JSONStore,
  SandboxFactory,
  ToolRegistry,
} from '../../../src';
import { ContentBlock } from '../../../src/core/types';
import { ModelConfig } from '../../../src/infra/provider';
import { TEST_ROOT } from '../../helpers/fixtures';
import { ensureCleanDir } from '../../helpers/setup';
import { ProviderEnvConfig, ProviderId } from '../../helpers/provider-env';

export const IMAGE_FILES = ['test.png', 'test.jpg', 'test.webp', 'test.gif'];
export const PDF_FILE = 'test.pdf';

const ASSET_DIR = path.resolve(__dirname, '../../helpers/multimodels_test');

export function getAssetPath(filename: string): string {
  return path.resolve(ASSET_DIR, filename);
}

export function assertAssetExists(filename: string): void {
  const filePath = getAssetPath(filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing test asset: ${filePath}`);
  }
}

export function readBase64(filePath: string): { base64: string; sizeBytes: number } {
  const buffer = fs.readFileSync(filePath);
  return { base64: buffer.toString('base64'), sizeBytes: buffer.length };
}

export function mimeTypeForFile(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

export function parseStrictJson(text: string): any {
  let trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Empty response; expected strict JSON');
  }

  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    trimmed = fenceMatch[1].trim();
  }

  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error(`Response is not strict JSON: ${trimmed.slice(0, 120)}`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error: any) {
    throw new Error(`Invalid JSON response: ${error?.message || error}`);
  }
}

export function extractLastAssistantText(messages: Array<{ role: string; content: ContentBlock[]; metadata?: any }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const blocks: ContentBlock[] = message.metadata?.content_blocks ?? message.content ?? [];
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => (block as any).text || '')
      .join('\n')
      .trim();
    if (text) {
      return text;
    }
  }
  return '';
}

export function buildMultimodalConfig(): ModelConfig['multimodal'] {
  return {
    mode: 'url+base64',
    maxBase64Bytes: 20000000,
    allowMimeTypes: [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'application/pdf',
    ],
  };
}

export function defaultTemplate(id: string) {
  return {
    id,
    systemPrompt: 'You are a multimodal integration test agent.',
    tools: [],
    permission: { mode: 'auto' as const },
  };
}

export async function createProviderAgent(options: {
  providerId: ProviderId;
  env: ProviderEnvConfig;
  template: any;
  exposeThinking?: boolean;
  retainThinking?: boolean;
  reasoningTransport?: ModelConfig['reasoningTransport'];
  metadata?: Record<string, any>;
  registerTools?: (registry: ToolRegistry) => void;
  providerOptions?: Record<string, any>;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  multimodal?: ModelConfig['multimodal'];
}): Promise<{
  agent: Agent;
  deps: AgentDependencies;
  cleanup: () => Promise<void>;
}> {
  const storeDir = path.join(
    TEST_ROOT,
    `int-mm-${options.providerId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  );
  ensureCleanDir(storeDir);

  const store = new JSONStore(storeDir);
  const templates = new AgentTemplateRegistry();
  const tools = new ToolRegistry();
  const sandboxFactory = new SandboxFactory();

  options.registerTools?.(tools);
  templates.register(options.template);

  const modelConfig: ModelConfig = {
    provider: options.providerId,
    apiKey: options.env.apiKey,
    model: options.env.model || 'unknown-model',
    baseUrl: options.env.baseUrl,
    proxyUrl: options.env.proxyUrl,
    reasoningTransport: options.reasoningTransport,
    extraHeaders: options.extraHeaders,
    extraBody: options.extraBody,
    providerOptions: options.providerOptions,
    multimodal: options.multimodal,
  };

  const deps: AgentDependencies = {
    store,
    templateRegistry: templates,
    sandboxFactory,
    toolRegistry: tools,
  };

  const config: AgentConfig = {
    templateId: options.template.id,
    modelConfig,
    exposeThinking: options.exposeThinking,
    retainThinking: options.retainThinking,
    metadata: options.metadata,
    sandbox: { kind: 'local', workDir: storeDir, enforceBoundary: true },
  };

  const agent = await Agent.create(config, deps);
  // Prevent EventEmitter 'error' from crashing tests when monitor error events fire.
  agent.on('error', () => {});

  return {
    agent,
    deps,
    cleanup: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

export function buildImageBlocks(prompt: string, filename: string, base64: string): ContentBlock[] {
  return [
    { type: 'text', text: prompt },
    { type: 'image', base64, mime_type: mimeTypeForFile(filename) },
  ];
}

export function buildPdfBlocks(prompt: string, filename: string, base64: string): ContentBlock[] {
  return [
    { type: 'text', text: prompt },
    { type: 'file', base64, mime_type: mimeTypeForFile(filename), filename },
  ];
}
