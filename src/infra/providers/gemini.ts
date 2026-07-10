/**
 * Gemini Provider Adapter
 *
 * Converts internal Anthropic-style messages to Gemini API format.
 * Supports:
 * - Thinking with thinkingBudget (2.5 models) or thinkingLevel (3.x models)
 * - Files API with GCS URIs
 * - Streaming with SSE
 * - Function calling
 */

import { Message, ContentBlock, ImageContentBlock, FileContentBlock, AudioContentBlock, VideoContentBlock } from '../../core/types';
import {
  ModelProvider,
  ModelResponse,
  ModelStreamChunk,
  ModelConfig,
  UploadFileInput,
  UploadFileResult,
  CompletionOptions,
  ReasoningTransport,
  ThinkingOptions,
} from './types';
import {
  normalizeGeminiBaseUrl,
  getProxyDispatcher,
  withProxy,
  getMessageBlocks,
  markTransportIfDegraded,
  concatTextWithReasoning,
  normalizeThinkBlocks,
  safeJsonStringify,
  buildGeminiImagePart,
  buildGeminiFilePart,
  buildGeminiAudioPart,
  buildGeminiVideoPart,
  sanitizeGeminiSchema,
  IMAGE_UNSUPPORTED_TEXT,
  AUDIO_UNSUPPORTED_TEXT,
  VIDEO_UNSUPPORTED_TEXT,
  FILE_UNSUPPORTED_TEXT,
} from './utils';

export interface GeminiProviderOptions {
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;
  multimodal?: ModelConfig['multimodal'];
  thinking?: ThinkingOptions;
}

type GeminiDecodedPart =
  | { type: 'text'; text: string; thoughtSignature?: string }
  | { type: 'reasoning'; text: string; thoughtSignature?: string }
  | { type: 'tool_use'; id?: string; name: string; args: any; thoughtSignature?: string };

export class GeminiProvider implements ModelProvider {
  readonly maxWindowSize = 1_000_000;
  readonly maxOutputTokens = 4096;
  readonly temperature = 0.7;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly dispatcher?: any;
  private readonly reasoningTransport: ReasoningTransport;
  private readonly extraHeaders?: Record<string, string>;
  private readonly extraBody?: Record<string, any>;
  private readonly providerOptions?: Record<string, any>;
  private readonly multimodal?: ModelConfig['multimodal'];
  private readonly thinking?: ThinkingOptions;

  constructor(
    private apiKey: string,
    model: string = 'gemini-3.0-flash',
    baseUrl: string = 'https://generativelanguage.googleapis.com/v1beta',
    proxyUrl?: string,
    options?: GeminiProviderOptions
  ) {
    this.model = model;
    this.baseUrl = normalizeGeminiBaseUrl(baseUrl);
    this.dispatcher = getProxyDispatcher(proxyUrl);
    this.reasoningTransport = options?.reasoningTransport ?? 'text';
    this.extraHeaders = options?.extraHeaders;
    this.extraBody = options?.extraBody;
    this.providerOptions = options?.providerOptions;
    this.multimodal = options?.multimodal;
    this.thinking = options?.thinking;
  }

  async uploadFile(input: UploadFileInput): Promise<UploadFileResult | null> {
    // Gemini supports uploading audio, video, and file types
    if (input.kind !== 'file' && input.kind !== 'audio' && input.kind !== 'video') {
      return null;
    }
    const url = new URL(`${this.baseUrl}/files`);
    url.searchParams.set('key', this.apiKey);

    // Determine display name based on kind
    let defaultFilename: string;
    if (input.kind === 'audio') {
      defaultFilename = 'audio.wav';
    } else if (input.kind === 'video') {
      defaultFilename = 'video.mp4';
    } else {
      defaultFilename = 'file.pdf';
    }

    const body = {
      file: {
        display_name: input.filename || defaultFilename,
        mime_type: input.mimeType,
      },
      content: input.data.toString('base64'),
    };

    const response = await fetch(
      url.toString(),
      withProxy(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.extraHeaders || {}),
          },
          body: JSON.stringify(body),
        },
        this.dispatcher
      )
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini file upload error: ${response.status} ${error}`);
    }

    const data: any = await response.json();
    const fileUri = data?.file?.uri ?? data?.uri ?? data?.file_uri;
    if (!fileUri) {
      return null;
    }
    return { fileUri };
  }

  async complete(messages: Message[], opts?: CompletionOptions): Promise<ModelResponse> {
    const body: any = {
      ...(this.extraBody || {}),
      ...this.buildGeminiRequestBody(messages, {
        system: opts?.system,
        tools: opts?.tools,
        maxTokens: opts?.maxTokens ?? this.maxOutputTokens,
        temperature: opts?.temperature ?? this.temperature,
        reasoningTransport: this.reasoningTransport,
        thinking: opts?.thinking ?? this.thinking,
      }),
    };

    const url = this.buildGeminiUrl('generateContent');
    const response = await fetch(
      url.toString(),
      withProxy(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.extraHeaders || {}),
          },
          body: JSON.stringify(body),
        },
        this.dispatcher
      )
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${error}`);
    }

    const data: any = await response.json();
    const candidate = data?.candidates?.[0];
    const contentBlocks = normalizeThinkBlocks(
      this.extractGeminiContentBlocks(candidate?.content),
      this.reasoningTransport
    );
    const usage = data?.usageMetadata;

    return {
      role: 'assistant',
      content: contentBlocks,
      usage: usage
        ? {
            input_tokens: usage.promptTokenCount ?? 0,
            output_tokens: usage.candidatesTokenCount ?? 0,
          }
        : undefined,
      stop_reason: candidate?.finishReason,
    };
  }

  async *stream(messages: Message[], opts?: CompletionOptions): AsyncIterable<ModelStreamChunk> {
    const body: any = {
      ...(this.extraBody || {}),
      ...this.buildGeminiRequestBody(messages, {
        system: opts?.system,
        tools: opts?.tools,
        maxTokens: opts?.maxTokens ?? this.maxOutputTokens,
        temperature: opts?.temperature ?? this.temperature,
        reasoningTransport: this.reasoningTransport,
        thinking: opts?.thinking ?? this.thinking,
      }),
    };

    const url = this.buildGeminiUrl('streamGenerateContent');
    const response = await fetch(
      url.toString(),
      withProxy(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.extraHeaders || {}),
          },
          body: JSON.stringify(body),
        },
        this.dispatcher
      )
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${error}`);
    }

    let nextBlockIndex = 0;
    let activeBlock: { type: 'text' | 'reasoning'; index: number } | undefined;
    let lastUsage: { input: number; output: number } | undefined;

    function* closeActiveBlock(): Generator<ModelStreamChunk> {
      if (!activeBlock) return;
      yield { type: 'content_block_stop', index: activeBlock.index };
      activeBlock = undefined;
    }

    function* emitPart(part: GeminiDecodedPart): Generator<ModelStreamChunk> {
      if (part.type === 'tool_use') {
        yield* closeActiveBlock();
        const index = nextBlockIndex++;
        const id = part.id ?? `toolcall-${Date.now()}-${index}`;
        const meta = {
          ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}),
          ...(!part.id ? { gemini_function_call_id_present: false } : {}),
        };
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id,
            name: part.name,
            input: {},
            ...(Object.keys(meta).length > 0 ? { meta } : {}),
          },
        };
        yield {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: safeJsonStringify(part.args) },
        };
        yield { type: 'content_block_stop', index };
        return;
      }

      if (part.thoughtSignature) {
        yield* closeActiveBlock();
        const index = nextBlockIndex++;
        const meta = { thought_signature: part.thoughtSignature };
        yield {
          type: 'content_block_start',
          index,
          content_block:
            part.type === 'reasoning'
              ? { type: 'reasoning', reasoning: '', meta }
              : { type: 'text', text: '', meta },
        };
        if (part.text.length > 0) {
          yield {
            type: 'content_block_delta',
            index,
            delta:
              part.type === 'reasoning'
                ? { type: 'reasoning_delta', text: part.text }
                : { type: 'text_delta', text: part.text },
          };
        }
        yield { type: 'content_block_stop', index };
        return;
      }

      if (part.text.length === 0) return;
      if (!activeBlock || activeBlock.type !== part.type) {
        yield* closeActiveBlock();
        const index = nextBlockIndex++;
        activeBlock = { type: part.type, index };
        yield {
          type: 'content_block_start',
          index,
          content_block:
            part.type === 'reasoning'
              ? { type: 'reasoning', reasoning: '' }
              : { type: 'text', text: '' },
        };
      }

      yield {
        type: 'content_block_delta',
        index: activeBlock.index,
        delta:
          part.type === 'reasoning'
            ? { type: 'reasoning_delta', text: part.text }
            : { type: 'text_delta', text: part.text },
      };
    }

    try {
      for await (const payload of this.iterateGeminiStreamEvents(response)) {
        const events = Array.isArray(payload) ? payload : [payload];
        for (const event of events) {
          const { parts, usage } = this.parseGeminiChunk(event);
          if (usage) {
            lastUsage = usage;
          }
          for (const part of parts) {
            yield* emitPart(part);
          }
        }
      }
    } catch (error) {
      yield* closeActiveBlock();
      throw error;
    }

    yield* closeActiveBlock();

    if (lastUsage) {
      yield {
        type: 'message_delta',
        usage: {
          input_tokens: lastUsage.input,
          output_tokens: lastUsage.output,
        },
      };
    }
  }

  toConfig(): ModelConfig {
    return {
      provider: 'gemini',
      model: this.model,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      maxTokens: this.maxOutputTokens,
      temperature: this.temperature,
      reasoningTransport: this.reasoningTransport,
      extraHeaders: this.extraHeaders,
      extraBody: this.extraBody,
      providerOptions: this.providerOptions,
      multimodal: this.multimodal,
      thinking: this.thinking,
    };
  }

  private buildGeminiUrl(action: 'generateContent' | 'streamGenerateContent'): URL {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, '')}/models/${this.model}:${action}`);
    url.searchParams.set('key', this.apiKey);
    if (action === 'streamGenerateContent') {
      url.searchParams.set('alt', 'sse');
    }
    return url;
  }

  private async *iterateGeminiStreamEvents(response: Response): AsyncGenerator<any> {
    const parseJsonPayload = (payload: string, context: string): any[] => {
      const trimmed = payload.trim();
      if (!trimmed) return [];
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error: any) {
        throw new Error(`Gemini stream parse error in ${context}: ${error?.message ?? 'invalid JSON'}`);
      }
      return Array.isArray(parsed) ? parsed : [parsed];
    };

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    const doneMarker = Symbol('done');
    let wireMode: 'unknown' | 'sse' | 'json' = 'unknown';
    let buffer = '';
    let dataLines: string[] = [];
    let frameIndex = 0;

    const dispatchFrame = (): any | typeof doneMarker | undefined => {
      if (dataLines.length === 0) return undefined;
      const data = dataLines.join('\n');
      dataLines = [];
      frameIndex += 1;
      if (data.trim() === '[DONE]') return doneMarker;
      try {
        return JSON.parse(data);
      } catch (error: any) {
        throw new Error(
          `Gemini stream parse error in SSE frame ${frameIndex}: ${error?.message ?? 'invalid JSON'}`
        );
      }
    };

    const consumeLine = (rawLine: string): any | typeof doneMarker | undefined => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) return dispatchFrame();
      if (line.startsWith(':')) return undefined;

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
      return undefined;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

        if (wireMode === 'unknown') {
          const start = buffer.trimStart();
          if (start.startsWith('[') || start.startsWith('{')) {
            wireMode = 'json';
          } else {
            const firstLine = start.split(/\r?\n/, 1)[0];
            if (
              firstLine.startsWith('data:') ||
              firstLine.startsWith('event:') ||
              firstLine.startsWith('id:') ||
              firstLine.startsWith('retry:') ||
              firstLine.startsWith(':')
            ) {
              wireMode = 'sse';
            }
          }
        }

        if (wireMode === 'json') {
          if (!done) continue;
          for (const event of parseJsonPayload(buffer, 'JSON-array fallback')) {
            yield event;
          }
          return;
        }

        if (wireMode === 'unknown') {
          if (done && buffer.trim().length > 0) {
            throw new Error('Gemini stream parse error: unrecognized response framing');
          }
          if (done) return;
          continue;
        }

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const event = consumeLine(line);
          if (event === doneMarker) return;
          if (event !== undefined) yield event;
        }

        if (done) break;
      }

      if (buffer.length > 0) {
        const event = consumeLine(buffer);
        if (event === doneMarker) return;
        if (event !== undefined) yield event;
      }
      const finalEvent = dispatchFrame();
      if (finalEvent !== undefined && finalEvent !== doneMarker) {
        yield finalEvent;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed or errored.
      }
      reader.releaseLock();
    }
  }

  private buildGeminiRequestBody(
    messages: Message[],
    opts: {
      system?: string;
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      reasoningTransport?: ReasoningTransport;
      thinking?: ThinkingOptions;
    }
  ): any {
    const systemInstruction = this.buildGeminiSystemInstruction(messages, opts.system, opts.reasoningTransport);
    const contents = this.buildGeminiContents(messages, opts.reasoningTransport);
    const tools = opts.tools && opts.tools.length > 0 ? this.buildGeminiTools(opts.tools) : undefined;

    const generationConfig: any = {};
    if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) generationConfig.maxOutputTokens = opts.maxTokens;

    if (opts.thinking?.budgetTokens !== undefined) {
      generationConfig.thinkingConfig = {
        thinkingBudget: opts.thinking.budgetTokens,
        includeThoughts: true,
      };
    } else if (opts.thinking?.level) {
      generationConfig.thinkingConfig = {
        thinkingLevel: opts.thinking.level.toUpperCase(),
        includeThoughts: true,
      };
    }

    const body: any = {
      contents,
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    if (tools) {
      body.tools = tools;
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    return body;
  }

  private buildGeminiSystemInstruction(
    messages: Message[],
    system?: string,
    reasoningTransport: ReasoningTransport = 'text'
  ): string | undefined {
    const parts: string[] = [];
    if (system) parts.push(system);
    for (const msg of messages) {
      if (msg.role !== 'system') continue;
      const text = concatTextWithReasoning(getMessageBlocks(msg), reasoningTransport);
      if (text) parts.push(text);
    }
    if (parts.length === 0) return undefined;
    return parts.join('\n\n---\n\n');
  }

  private buildGeminiContents(messages: Message[], reasoningTransport: ReasoningTransport = 'text'): any[] {
    const contents: any[] = [];
    const toolNameById = new Map<string, string>();
    const toolSignatureById = new Map<string, string>();
    const toolHasProviderIdById = new Map<string, boolean>();

    for (const msg of messages) {
      for (const block of getMessageBlocks(msg)) {
        if (block.type === 'tool_use') {
          toolNameById.set(block.id, block.name);
          toolHasProviderIdById.set(block.id, block.meta?.gemini_function_call_id_present !== false);
          const signature = (block as any).meta?.thought_signature ?? (block as any).meta?.thoughtSignature;
          if (typeof signature === 'string' && signature.length > 0) {
            toolSignatureById.set(block.id, signature);
          }
        }
      }
    }

    for (const msg of messages) {
      if (msg.role === 'system') continue;
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts: any[] = [];
      let degraded = false;
      const blocks = getMessageBlocks(msg);
      for (const block of blocks) {
        if (block.type === 'text') {
          const thoughtSignature = block.meta?.thought_signature ?? block.meta?.thoughtSignature;
          if (block.text || thoughtSignature) {
            parts.push({
              text: block.text,
              ...(thoughtSignature ? { thoughtSignature } : {}),
            });
          }
        } else if (block.type === 'reasoning') {
          if (reasoningTransport === 'text') {
            // A thought signature is valid only on the exact native Part. Text transport
            // intentionally rewrites that Part for cross-provider compatibility.
            const text = `<think>${block.reasoning}</think>`;
            parts.push({ text });
          } else if (reasoningTransport === 'provider') {
            const thoughtSignature = block.meta?.thought_signature ?? block.meta?.thoughtSignature;
            parts.push({
              text: block.reasoning,
              thought: true,
              ...(thoughtSignature ? { thoughtSignature } : {}),
            });
          }
        } else if (block.type === 'image') {
          const imagePart = buildGeminiImagePart(block);
          if (imagePart) {
            parts.push(imagePart);
          } else {
            degraded = true;
            parts.push({ text: IMAGE_UNSUPPORTED_TEXT });
          }
        } else if (block.type === 'audio') {
          const audioPart = buildGeminiAudioPart(block);
          if (audioPart) {
            parts.push(audioPart);
          } else {
            degraded = true;
            parts.push({ text: AUDIO_UNSUPPORTED_TEXT });
          }
        } else if (block.type === 'video') {
          const videoPart = buildGeminiVideoPart(block);
          if (videoPart) {
            parts.push(videoPart);
          } else {
            degraded = true;
            parts.push({ text: VIDEO_UNSUPPORTED_TEXT });
          }
        } else if (block.type === 'file') {
          const filePart = buildGeminiFilePart(block);
          if (filePart) {
            parts.push(filePart);
          } else {
            degraded = true;
            parts.push({ text: FILE_UNSUPPORTED_TEXT });
          }
        } else if (block.type === 'tool_use') {
          const includeId = toolHasProviderIdById.get(block.id) !== false;
          const part: any = {
            functionCall: {
              ...(includeId ? { id: block.id } : {}),
              name: block.name,
              args: this.normalizeGeminiArgs(block.input),
            },
          };
          const signature = toolSignatureById.get(block.id);
          if (signature) {
            part.thoughtSignature = signature;
          }
          parts.push(part);
        } else if (block.type === 'tool_result') {
          const toolName = toolNameById.get(block.tool_use_id) ?? 'tool';
          const includeId = toolHasProviderIdById.get(block.tool_use_id) !== false;
          parts.push({
            functionResponse: {
              ...(includeId ? { id: block.tool_use_id } : {}),
              name: toolName,
              response: { content: this.formatGeminiToolResult(block.content) },
            },
          });
        }
      }
      if (degraded) {
        markTransportIfDegraded(msg, blocks);
      }
      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }
    return contents;
  }

  private buildGeminiTools(tools: any[]): any[] {
    return [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: sanitizeGeminiSchema(tool.input_schema),
        })),
      },
    ];
  }

  private normalizeGeminiArgs(input: any): Record<string, any> {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      return input;
    }
    return { value: input };
  }

  private formatGeminiToolResult(content: any): string {
    if (typeof content === 'string') return content;
    return safeJsonStringify(content);
  }

  private extractGeminiContentBlocks(content: any): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    for (const part of this.decodeGeminiParts(content)) {
      if (part.type === 'text' || part.type === 'reasoning') {
        const meta = part.thoughtSignature
          ? { thought_signature: part.thoughtSignature }
          : undefined;
        blocks.push(
          part.type === 'reasoning'
            ? { type: 'reasoning', reasoning: part.text, ...(meta ? { meta } : {}) }
            : { type: 'text', text: part.text, ...(meta ? { meta } : {}) }
        );
      } else {
        const hasProviderId = part.id !== undefined;
        const meta = {
          ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}),
          ...(!hasProviderId ? { gemini_function_call_id_present: false } : {}),
        };
        blocks.push({
          type: 'tool_use',
          id: part.id ?? `toolcall-${Date.now()}-${blocks.length}`,
          name: part.name,
          input: part.args,
          ...(Object.keys(meta).length > 0 ? { meta } : {}),
        });
      }
    }
    return blocks;
  }

  private parseGeminiChunk(event: any): {
    parts: GeminiDecodedPart[];
    usage?: { input: number; output: number };
  } {
    const parsedParts: GeminiDecodedPart[] = [];

    const candidates = Array.isArray(event?.candidates) ? event.candidates : [];
    for (const candidate of candidates) {
      parsedParts.push(...this.decodeGeminiParts(candidate?.content));
    }

    const usageMetadata = event?.usageMetadata;
    const usage = usageMetadata
      ? {
          input: usageMetadata.promptTokenCount ?? 0,
          output: usageMetadata.candidatesTokenCount ?? 0,
        }
      : undefined;

    return { parts: parsedParts, usage };
  }

  private decodeGeminiParts(content: any): GeminiDecodedPart[] {
    const decoded: GeminiDecodedPart[] = [];
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const part of parts) {
      if (typeof part?.text === 'string') {
        const thoughtSignature =
          typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0
            ? part.thoughtSignature
            : undefined;
        if (part.text.length === 0 && !thoughtSignature) continue;
        decoded.push({
          type: part.thought === true ? 'reasoning' : 'text',
          text: part.text,
          ...(thoughtSignature ? { thoughtSignature } : {}),
        });
      } else if (part?.functionCall) {
        const thoughtSignature = part.thoughtSignature ?? part.functionCall.thoughtSignature;
        decoded.push({
          type: 'tool_use',
          ...(typeof part.functionCall.id === 'string' && part.functionCall.id.length > 0
            ? { id: part.functionCall.id }
            : {}),
          name: part.functionCall.name ?? 'tool',
          args: part.functionCall.args ?? {},
          ...(thoughtSignature ? { thoughtSignature } : {}),
        });
      }
    }
    return decoded;
  }
}
