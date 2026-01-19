import { TestRunner, expect } from '../../helpers/utils';
import { loadProviderEnv, ProviderId } from '../../helpers/provider-env';
import {
  IMAGE_FILES,
  PDF_FILE,
  assertAssetExists,
  buildImageBlocks,
  buildPdfBlocks,
  buildMultimodalConfig,
  createProviderAgent,
  defaultTemplate,
  extractLastAssistantText,
  getAssetPath,
  parseStrictJson,
  readBase64,
} from './utils';

const runner = new TestRunner('集成测试 - 多模态');

const PROVIDERS: ProviderId[] = ['openai', 'gemini', 'anthropic', 'glm', 'minimax'];

const IMAGE_PROMPT =
  '图中有哪些动物？从 {cat,dog,rabbit,bird} 中选择，只输出 JSON：{"animals":[...]}。不要使用 Markdown 或代码块。';
const PDF_PROMPT =
  '请从 PDF 中提取标题与短语，原样抄写，不要翻译或改写，仅输出 JSON：{"title":"...","phrase":"..."}。不要使用 Markdown 或代码块。';

function shouldRunPdf(provider: ProviderId, envConfig: ReturnType<typeof loadProviderEnv>['config']): { ok: boolean; reason?: string } {
  if (!envConfig) return { ok: false, reason: 'missing env config' };
  if (envConfig.enablePdf === false) return { ok: false, reason: 'PDF disabled by env flag' };
  if (provider === 'openai' && envConfig.openaiApi !== 'responses') {
    return { ok: false, reason: 'OpenAI PDF requires OPENAI_OPENAI_API=responses' };
  }
  if (provider === 'anthropic' && (envConfig.baseUrl || '').includes('openai-next.com')) {
    return { ok: false, reason: 'Anthropic file API not available on openai-next' };
  }
  if (provider === 'glm' || provider === 'minimax') {
    return { ok: false, reason: 'OpenAI-compatible chat API does not support PDF input in this SDK' };
  }
  return { ok: true };
}

function normalizeAnimals(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

function normalizeKeyword(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function matchesFunPhrase(value: string): boolean {
  const normalized = normalizeKeyword(value);
  if (!normalized) return false;
  if (normalized.includes('fun fun fun')) return true;
  const funCount = normalized.split('fun').length - 1;
  if (funCount >= 2 && (normalized.includes('pdf') || normalized.includes('sample') || normalized.includes('simple'))) {
    return true;
  }
  return false;
}

async function collectMonitorErrors(store: any, agentId: string): Promise<string[]> {
  const errors: string[] = [];
  for await (const entry of store.readEvents(agentId, { channel: 'monitor' })) {
    const event = (entry as any).event || {};
    if (event.type === 'error') {
      const detail = event.detail ? JSON.stringify(event.detail) : '';
      errors.push([event.message, detail].filter(Boolean).join(' '));
    }
  }
  return errors;
}

function describeLastAssistant(messages: Array<{ role: string; content: any; metadata?: any }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const blocks = message.metadata?.content_blocks ?? message.content ?? [];
    if (blocks.length === 0) {
      return '[assistant content empty]';
    }
    return `[assistant content] ${JSON.stringify(blocks).slice(0, 300)}`;
  }
  return '[assistant message not found]';
}

runner.test('图片多格式识别（png/jpg/webp/gif）', async () => {
  for (const filename of IMAGE_FILES) {
    assertAssetExists(filename);
  }

  for (const provider of PROVIDERS) {
    const env = loadProviderEnv(provider);
    if (!env.ok) {
      console.log(`[skip] ${provider}: ${env.reason}`);
      continue;
    }
    if (!env.config?.model) {
      console.log(`[skip] ${provider}: missing ${provider.toUpperCase()}_MODEL_ID`);
      continue;
    }

    for (const filename of IMAGE_FILES) {
      if (provider === 'gemini' && filename.toLowerCase().endsWith('.gif')) {
        console.log(`[skip] ${provider}: image/gif unsupported`);
        continue;
      }
      const { base64 } = readBase64(getAssetPath(filename));
      const template = defaultTemplate(`mm-image-${provider}-${filename.replace('.', '-')}`);
      const { agent, deps, cleanup } = await createProviderAgent({
        providerId: provider,
        env: env.config,
        template,
        multimodal: buildMultimodalConfig(),
        providerOptions: env.config.openaiApi ? { openaiApi: env.config.openaiApi } : undefined,
        extraHeaders: env.config.extraHeaders,
        extraBody: env.config.extraBody,
      });

      const result = await agent.chat(buildImageBlocks(IMAGE_PROMPT, filename, base64));
      let responseText = result.text ?? '';
      if (!responseText.trim()) {
        const messages = await deps.store.loadMessages(agent.agentId);
        responseText = extractLastAssistantText(messages);
      }
      if (!responseText.trim()) {
        const messages = await deps.store.loadMessages(agent.agentId);
        const errors = await collectMonitorErrors(deps.store, agent.agentId);
        const debug = describeLastAssistant(messages);
        const errorNote = errors.length > 0 ? ` monitorErrors=${errors.join(' | ')}` : '';
        throw new Error(`[${provider}][${filename}] Empty response; expected strict JSON. ${debug}${errorNote}`);
      }
      const parsed = parseStrictJson(responseText);
      const animals = normalizeAnimals(parsed.animals);
      animals.sort();
      expect.toEqual(animals.join(','), ['cat', 'dog'].join(','));

      await cleanup();
    }
  }
});

runner.test('PDF 内容识别', async () => {
  assertAssetExists(PDF_FILE);
  const { base64 } = readBase64(getAssetPath(PDF_FILE));

  for (const provider of PROVIDERS) {
    const env = loadProviderEnv(provider);
    if (!env.ok) {
      console.log(`[skip] ${provider}: ${env.reason}`);
      continue;
    }
    if (!env.config?.model) {
      console.log(`[skip] ${provider}: missing ${provider.toUpperCase()}_MODEL_ID`);
      continue;
    }

    const pdfSupport = shouldRunPdf(provider, env.config);
    if (!pdfSupport.ok) {
      console.log(`[skip] ${provider}: ${pdfSupport.reason}`);
      continue;
    }

    const template = defaultTemplate(`mm-pdf-${provider}`);
    const { agent, deps, cleanup } = await createProviderAgent({
      providerId: provider,
      env: env.config,
      template,
      multimodal: buildMultimodalConfig(),
      providerOptions: env.config.openaiApi ? { openaiApi: env.config.openaiApi } : undefined,
      extraHeaders: env.config.extraHeaders,
      extraBody: env.config.extraBody,
    });

    const result = await agent.chat(buildPdfBlocks(PDF_PROMPT, PDF_FILE, base64));
    let text = result.text ?? '';
    if (!text.trim()) {
      const messages = await deps.store.loadMessages(agent.agentId);
      text = extractLastAssistantText(messages);
    }
    if (!text.trim()) {
      const messages = await deps.store.loadMessages(agent.agentId);
      const errors = await collectMonitorErrors(deps.store, agent.agentId);
      const debug = describeLastAssistant(messages);
      const errorNote = errors.length > 0 ? ` monitorErrors=${errors.join(' | ')}` : '';
      throw new Error(`[${provider}] Empty response; expected PDF keywords. ${debug}${errorNote}`);
    }
    const expectedTitle = normalizeKeyword('Sample PDF');
    const expectedPhrase = normalizeKeyword('Fun fun fun');
    let parsed: any | undefined;
    try {
      parsed = parseStrictJson(text);
    } catch {
      parsed = undefined;
    }

    if (parsed) {
      const titleValue = normalizeKeyword(String(parsed.title ?? ''));
      const phraseValue = String(parsed.phrase ?? '');
      expect.toEqual(titleValue, expectedTitle);
      expect.toEqual(matchesFunPhrase(phraseValue), true, 'missing keyword: Fun fun fun');
    } else {
      const normalized = normalizeKeyword(text);
      expect.toBeTruthy(normalized.includes(expectedTitle), 'missing keyword: Sample PDF');
      expect.toEqual(matchesFunPhrase(normalized), true, 'missing keyword: Fun fun fun');
    }

    await cleanup();
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
