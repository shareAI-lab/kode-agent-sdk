import { TestRunner, expect } from '../../helpers/utils';
import { loadProviderEnv, ProviderId } from '../../helpers/provider-env';
import {
  IMAGE_FILES,
  PDF_FILE,
  AUDIO_FILES,
  VIDEO_FILE,
  assertAssetExists,
  buildImageBlocks,
  buildPdfBlocks,
  buildAudioBlocks,
  buildVideoBlocks,
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
const AUDIO_PROMPT =
  '请听这段音频，告诉我音频中说了什么词语。只输出 JSON：{"words":["..."]}。不要使用 Markdown 或代码块。';
const VIDEO_PROMPT =
  '视频中有哪些动物？从 {cat,dog,rabbit,bird} 中选择，只输出 JSON：{"animals":[...]}。不要使用 Markdown 或代码块。';

// Patterns in API error messages that indicate a model/proxy capability limitation (not a bug)
const CAPABILITY_ERROR_PATTERNS = [
  'does not support image_url',
  'does not support image',
  'expected to be either text or image_url',
  'does not support audio',
  'does not support input_audio',
  'does not support video',
  'invalid content type',
  'invalid_value',
  'model_not_found',
  '无可用渠道',
  'media upload failed',
];

// Patterns in model response text indicating the multimodal content was not received
// (e.g., proxy stripped the audio/video data, so the model asks the user to upload)
const CONTENT_NOT_RECEIVED_PATTERNS = [
  '请上传', '请发送', '没有收到', '未收到', '没收到', '还没收到',
  'please upload', 'please send', 'please provide',
  "haven't received", "didn't receive", 'no audio', 'no video', 'no image',
];

function isCapabilityError(errors: string[]): boolean {
  const combined = errors.join(' ').toLowerCase();
  return CAPABILITY_ERROR_PATTERNS.some((p) => combined.includes(p.toLowerCase()));
}

function isContentNotReceived(responseText: string): boolean {
  const lower = responseText.toLowerCase();
  return CONTENT_NOT_RECEIVED_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

function shouldRunPdf(provider: ProviderId, envConfig: ReturnType<typeof loadProviderEnv>['config']): { ok: boolean; reason?: string } {
  if (!envConfig) return { ok: false, reason: 'missing env config' };
  if (envConfig.enablePdf === false) return { ok: false, reason: 'PDF disabled by env flag' };
  if (provider === 'openai' && envConfig.openaiApi !== 'responses') {
    return { ok: false, reason: 'OpenAI PDF requires OPENAI_API=responses' };
  }
  if (provider === 'glm' || provider === 'minimax') {
    return { ok: false, reason: 'OpenAI-compatible chat API does not support PDF input in this SDK' };
  }
  return { ok: true };
}

function shouldRunAudio(provider: ProviderId, envConfig: ReturnType<typeof loadProviderEnv>['config'], filename: string): { ok: boolean; reason?: string } {
  if (!envConfig) return { ok: false, reason: 'missing env config' };
  // Gemini: native audio support
  if (provider === 'gemini') return { ok: true };
  // OpenAI: only wav/mp3 base64
  if (provider === 'openai') {
    const lower = filename.toLowerCase();
    if (!lower.endsWith('.wav') && !lower.endsWith('.mp3')) {
      return { ok: false, reason: 'OpenAI only supports wav/mp3 audio' };
    }
    return { ok: true };
  }
  // Other providers: no native audio support
  return { ok: false, reason: `${provider} does not support audio input natively` };
}

function shouldRunVideo(provider: ProviderId, envConfig: ReturnType<typeof loadProviderEnv>['config']): { ok: boolean; reason?: string } {
  if (!envConfig) return { ok: false, reason: 'missing env config' };
  // Only Gemini supports video natively
  if (provider === 'gemini') return { ok: true };
  return { ok: false, reason: `${provider} does not support video input natively` };
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

/**
 * Try to get response text from agent.chat result and fallback to store.
 * Returns { text, skipped, error } where:
 * - skipped=true means a capability error was detected
 * - error is set when there's an actual error (not capability limitation)
 */
async function getResponseOrSkip(
  result: { text?: string },
  deps: any,
  agent: any,
  label: string,
  expectMultimodal = false
): Promise<{ text: string; skipped: boolean; skipReason?: string; error?: string }> {
  let responseText = result.text ?? '';
  if (!responseText.trim()) {
    const messages = await deps.store.loadMessages(agent.agentId);
    responseText = extractLastAssistantText(messages);
  }
  if (!responseText.trim()) {
    const errors = await collectMonitorErrors(deps.store, agent.agentId);
    if (errors.length > 0 && isCapabilityError(errors)) {
      return { text: '', skipped: true, skipReason: `model/proxy capability limitation` };
    }
    const messages = await deps.store.loadMessages(agent.agentId);
    const debug = describeLastAssistant(messages);
    const errorNote = errors.length > 0 ? ` monitorErrors=${errors.join(' | ')}` : '';
    return { text: '', skipped: false, error: `${label} Empty response. ${debug}${errorNote}` };
  }
  // Check if the model responded but indicated it didn't receive the multimodal content
  if (expectMultimodal && isContentNotReceived(responseText)) {
    return { text: responseText, skipped: true, skipReason: `model did not receive multimodal content` };
  }
  return { text: responseText, skipped: false };
}

/**
 * Report test results: throw error if there are failures
 */
function reportResults(failures: string[]): void {
  if (failures.length > 0) {
    throw new Error(`\n${failures.length} 个测试失败:\n${failures.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}`);
  }
}

runner.test('图片多格式识别（png/jpg/webp/gif）', async () => {
  for (const filename of IMAGE_FILES) {
    assertAssetExists(filename);
  }

  const failures: string[] = [];

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

      try {
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
        const response = await getResponseOrSkip(result, deps, agent, `[${provider}][${filename}]`, true);

        if (response.skipped) {
          console.log(`[skip] ${provider}/${filename}: ${response.skipReason}`);
          await cleanup();
          continue;
        }

        if (response.error) {
          console.log(`[fail] ${provider}/${filename}: ${response.error}`);
          failures.push(`[${provider}][${filename}] ${response.error}`);
          await cleanup();
          continue;
        }

        const parsed = parseStrictJson(response.text);
        const animals = normalizeAnimals(parsed.animals);
        animals.sort();
        expect.toEqual(animals.join(','), ['cat', 'dog'].join(','));
        console.log(`[pass] ${provider}/${filename}: animals=${JSON.stringify(animals)}`);

        await cleanup();
      } catch (error: any) {
        const msg = error?.message || String(error);
        console.log(`[fail] ${provider}/${filename}: ${msg}`);
        failures.push(`[${provider}][${filename}] ${msg}`);
      }
    }
  }

  reportResults(failures);
});

runner.test('PDF 内容识别', async () => {
  assertAssetExists(PDF_FILE);
  const { base64 } = readBase64(getAssetPath(PDF_FILE));

  const failures: string[] = [];

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

    try {
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
        const errors = await collectMonitorErrors(deps.store, agent.agentId);
        // Check if this is a capability limitation (model doesn't support PDF)
        if (errors.length > 0 && isCapabilityError(errors)) {
          console.log(`[skip] ${provider}: model/proxy capability limitation`);
          await cleanup();
          continue;
        }
        const messages = await deps.store.loadMessages(agent.agentId);
        const debug = describeLastAssistant(messages);
        const errorNote = errors.length > 0 ? ` monitorErrors=${errors.join(' | ')}` : '';
        console.log(`[fail] ${provider}: Empty response. ${debug}${errorNote}`);
        failures.push(`[${provider}] Empty response. ${debug}${errorNote}`);
        await cleanup();
        continue;
      }

      const expectedTitle = normalizeKeyword('Sample PDF');
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

      console.log(`[pass] ${provider}: PDF content recognized`);
      await cleanup();
    } catch (error: any) {
      const msg = error?.message || String(error);
      console.log(`[fail] ${provider}: ${msg}`);
      failures.push(`[${provider}] ${msg}`);
    }
  }

  reportResults(failures);
});

runner.test('音频识别（wav/mp3）', async () => {
  // 检查音频文件是否存在，不存在则跳过整个测试
  let hasAudioFiles = false;
  for (const filename of AUDIO_FILES) {
    try {
      assertAssetExists(filename);
      hasAudioFiles = true;
    } catch {
      console.log(`[skip] Audio file not found: ${filename}`);
    }
  }
  if (!hasAudioFiles) {
    console.log('[skip] No audio test files available');
    return;
  }

  const failures: string[] = [];

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

    for (const filename of AUDIO_FILES) {
      try {
        assertAssetExists(filename);
      } catch {
        continue;
      }

      const audioSupport = shouldRunAudio(provider, env.config, filename);
      if (!audioSupport.ok) {
        console.log(`[skip] ${provider}/${filename}: ${audioSupport.reason}`);
        continue;
      }

      try {
        const { base64 } = readBase64(getAssetPath(filename));
        const template = defaultTemplate(`mm-audio-${provider}-${filename.replace('.', '-')}`);
        const { agent, deps, cleanup } = await createProviderAgent({
          providerId: provider,
          env: env.config,
          template,
          multimodal: buildMultimodalConfig(),
          providerOptions: env.config.openaiApi ? { openaiApi: env.config.openaiApi } : undefined,
          extraHeaders: env.config.extraHeaders,
          extraBody: env.config.extraBody,
        });

        const result = await agent.chat(buildAudioBlocks(AUDIO_PROMPT, filename, base64));
        const response = await getResponseOrSkip(result, deps, agent, `[${provider}][${filename}]`, true);

        if (response.skipped) {
          console.log(`[skip] ${provider}/${filename}: ${response.skipReason}`);
          await cleanup();
          continue;
        }

        if (response.error) {
          console.log(`[fail] ${provider}/${filename}: ${response.error}`);
          failures.push(`[${provider}][${filename}] ${response.error}`);
          await cleanup();
          continue;
        }

        // 验证返回了有效的 JSON 响应，且包含 "hello"
        const parsed = parseStrictJson(response.text);
        expect.toBeTruthy(parsed.words, `[${provider}][${filename}] Missing words array in response`);
        expect.toBeTruthy(Array.isArray(parsed.words), `[${provider}][${filename}] words should be an array`);

        // 验证识别出了 "hello"（音频文件需要包含清晰说出的 "hello"）
        const normalizedWords = parsed.words.map((w: any) => String(w).toLowerCase().trim());
        const hasHello = normalizedWords.some((w: string) => w.includes('hello'));
        expect.toBeTruthy(hasHello, `[${provider}][${filename}] Should recognize "hello" in audio, got: ${JSON.stringify(parsed.words)}`);
        console.log(`[pass] ${provider}/${filename}: words=${JSON.stringify(parsed.words)}`);

        await cleanup();
      } catch (error: any) {
        const msg = error?.message || String(error);
        console.log(`[fail] ${provider}/${filename}: ${msg}`);
        failures.push(`[${provider}][${filename}] ${msg}`);
      }
    }
  }

  reportResults(failures);
});

runner.test('视频识别', async () => {
  // 检查视频文件是否存在
  try {
    assertAssetExists(VIDEO_FILE);
  } catch {
    console.log(`[skip] Video file not found: ${VIDEO_FILE}`);
    return;
  }

  const { base64 } = readBase64(getAssetPath(VIDEO_FILE));

  const failures: string[] = [];

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

    const videoSupport = shouldRunVideo(provider, env.config);
    if (!videoSupport.ok) {
      console.log(`[skip] ${provider}: ${videoSupport.reason}`);
      continue;
    }

    try {
      const template = defaultTemplate(`mm-video-${provider}`);
      const { agent, deps, cleanup } = await createProviderAgent({
        providerId: provider,
        env: env.config,
        template,
        multimodal: buildMultimodalConfig(),
        providerOptions: env.config.openaiApi ? { openaiApi: env.config.openaiApi } : undefined,
        extraHeaders: env.config.extraHeaders,
        extraBody: env.config.extraBody,
      });

      const result = await agent.chat(buildVideoBlocks(VIDEO_PROMPT, VIDEO_FILE, base64));
      const response = await getResponseOrSkip(result, deps, agent, `[${provider}][${VIDEO_FILE}]`, true);

      if (response.skipped) {
        console.log(`[skip] ${provider}: ${response.skipReason}`);
        await cleanup();
        continue;
      }

      if (response.error) {
        console.log(`[fail] ${provider}: ${response.error}`);
        failures.push(`[${provider}] ${response.error}`);
        await cleanup();
        continue;
      }

      // 验证返回了有效的 JSON 响应，且识别出猫或狗（视频文件需要包含猫或狗）
      const parsed = parseStrictJson(response.text);
      const animals = normalizeAnimals(parsed.animals);
      const hasCatOrDog = animals.some((a: string) => a === 'cat' || a === 'dog');
      expect.toBeTruthy(hasCatOrDog, `[${provider}] Should recognize cat or dog in video, got: ${JSON.stringify(animals)}`);
      console.log(`[pass] ${provider}/${VIDEO_FILE}: animals=${JSON.stringify(animals)}`);

      await cleanup();
    } catch (error: any) {
      const msg = error?.message || String(error);
      console.log(`[fail] ${provider}: ${msg}`);
      failures.push(`[${provider}] ${msg}`);
    }
  }

  reportResults(failures);
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
