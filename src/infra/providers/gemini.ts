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

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let textStarted = false;
    const textIndex = 0;
    let toolIndex = 1;
    const toolCalls: Array<{ name: string; args: any; thoughtSignature?: string }> = [];
    let lastUsage: { input: number; output: number } | undefined;
    let collectAll = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      if (collectAll) {
        buffer += chunk;
        continue;
      }

      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (let i = 0; i < lines.length; i++) {
        let trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('event:') || trimmed.startsWith(':')) continue;
        if (trimmed.startsWith('data:')) {
          trimmed = trimmed.slice(5).trim();
        }
        if (!trimmed || trimmed === '[DONE]') continue;
        if (trimmed.startsWith('[')) {
          collectAll = true;
          buffer = [trimmed, ...lines.slice(i + 1), buffer].filter(Boolean).join('\n');
          break;
        }

        let event: any;
        try {
          event = JSON.parse(trimmed);
        } catch {
          collectAll = true;
          buffer = [trimmed, ...lines.slice(i + 1), buffer].filter(Boolean).join('\n');
          break;
        }

        const { textChunks, functionCalls, usage } = this.parseGeminiChunk(event);
        if (usage) {
          lastUsage = usage;
        }

        for (const text of textChunks) {
          if (!textStarted) {
            textStarted = true;
            yield {
              type: 'content_block_start',
              index: textIndex,
              content_block: { type: 'text', text: '' },
            };
          }
          yield {
            type: 'content_block_delta',
            index: textIndex,
            delta: { type: 'text_delta', text },
          };
        }

        for (const call of functionCalls) {
          toolCalls.push(call);
        }
      }
    }

    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        const events = Array.isArray(parsed) ? parsed : [parsed];
        for (const event of events) {
          const { textChunks, functionCalls, usage } = this.parseGeminiChunk(event);
          if (usage) {
            lastUsage = usage;
          }
          for (const text of textChunks) {
            if (!textStarted) {
              textStarted = true;
              yield {
                type: 'content_block_start',
                index: textIndex,
                content_block: { type: 'text', text: '' },
              };
            }
            yield {
              type: 'content_block_delta',
              index: textIndex,
              delta: { type: 'text_delta', text },
            };
          }
          for (const call of functionCalls) {
            toolCalls.push(call);
          }
        }
      } catch {
        // ignore trailing buffer
      }
    }

    if (textStarted) {
      yield { type: 'content_block_stop', index: textIndex };
    }

    for (const call of toolCalls) {
      const id = `toolcall-${Date.now()}-${toolIndex}`;
      const meta = call.thoughtSignature ? { thought_signature: call.thoughtSignature } : undefined;
      yield {
        type: 'content_block_start',
        index: toolIndex,
        content_block: { type: 'tool_use', id, name: call.name, input: {}, ...(meta ? { meta } : {}) },
      };
      yield {
        type: 'content_block_delta',
        index: toolIndex,
        delta: { type: 'input_json_delta', partial_json: safeJsonStringify(call.args) },
      };
      yield { type: 'content_block_stop', index: toolIndex };
      toolIndex += 1;
    }

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

    if (opts.thinking?.budgetTokens) {
      generationConfig.thinkingConfig = { thinkingBudget: opts.thinking.budgetTokens };
    } else if (opts.thinking?.level) {
      generationConfig.thinkingConfig = { thinkingLevel: opts.thinking.level.toUpperCase() };
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

    for (const msg of messages) {
      for (const block of getMessageBlocks(msg)) {
        if (block.type === 'tool_use') {
          toolNameById.set(block.id, block.name);
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
          if (block.text) parts.push({ text: block.text });
        } else if (block.type === 'reasoning') {
          if (reasoningTransport === 'text') {
            const text = `<think>${block.reasoning}</think>`;
            parts.push({ text });
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
          const part: any = {
            functionCall: {
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
          parts.push({
            functionResponse: {
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
    const parts = content?.parts ?? [];
    for (const part of parts) {
      if (typeof part?.text === 'string') {
        blocks.push({ type: 'text', text: part.text });
      } else if (part?.functionCall) {
        const call = part.functionCall;
        const thoughtSignature = part?.thoughtSignature ?? call?.thoughtSignature;
        blocks.push({
          type: 'tool_use',
          id: `toolcall-${Date.now()}-${blocks.length}`,
          name: call.name ?? 'tool',
          input: call.args ?? {},
          ...(thoughtSignature ? { meta: { thought_signature: thoughtSignature } } : {}),
        });
      }
    }
    return blocks;
  }

  private parseGeminiChunk(event: any): {
    textChunks: string[];
    functionCalls: Array<{ name: string; args: any; thoughtSignature?: string }>;
    usage?: { input: number; output: number };
  } {
    const textChunks: string[] = [];
    const functionCalls: Array<{ name: string; args: any; thoughtSignature?: string }> = [];

    const candidates = Array.isArray(event?.candidates) ? event.candidates : [];
    for (const candidate of candidates) {
      const parts = candidate?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part?.text === 'string') {
          textChunks.push(part.text);
        } else if (part?.functionCall) {
          const thoughtSignature = part?.thoughtSignature ?? part?.functionCall?.thoughtSignature;
          functionCalls.push({
            name: part.functionCall.name ?? 'tool',
            args: part.functionCall.args ?? {},
            ...(thoughtSignature ? { thoughtSignature } : {}),
          });
        }
      }
    }

    const usageMetadata = event?.usageMetadata;
    const usage = usageMetadata
      ? {
          input: usageMetadata.promptTokenCount ?? 0,
          output: usageMetadata.candidatesTokenCount ?? 0,
        }
      : undefined;

    return { textChunks, functionCalls, usage };
  }
}
