/**
 * Anthropic Provider Adapter
 *
 * Converts internal Anthropic-style messages to Anthropic API format.
 * Supports:
 * - Extended thinking with interleaved-thinking-2025-05-14 beta
 * - Files API with files-api-2025-04-14 beta
 * - Streaming with SSE
 * - Signature preservation for multi-turn conversations
 */

import { Message, ContentBlock } from '../../core/types';
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
  normalizeAnthropicBaseUrl,
  getProxyDispatcher,
  withProxy,
  getMessageBlocks,
  markTransportIfDegraded,
  hasAnthropicFileBlocks,
  mergeAnthropicBetaHeader,
  formatToolResult,
  normalizeAnthropicContent,
  normalizeAnthropicContentBlock,
  normalizeAnthropicDelta,
  IMAGE_UNSUPPORTED_TEXT,
  AUDIO_UNSUPPORTED_TEXT,
  VIDEO_UNSUPPORTED_TEXT,
  FILE_UNSUPPORTED_TEXT,
} from './utils';

export interface AnthropicProviderOptions {
  reasoningTransport?: ReasoningTransport;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;
  multimodal?: ModelConfig['multimodal'];
  thinking?: ThinkingOptions;
}

export class AnthropicProvider implements ModelProvider {
  readonly maxWindowSize = 200_000;
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
    model: string = 'claude-3-5-sonnet-20241022',
    baseUrl: string = 'https://api.anthropic.com',
    proxyUrl?: string,
    options?: AnthropicProviderOptions
  ) {
    this.model = model;
    this.baseUrl = normalizeAnthropicBaseUrl(baseUrl);
    this.dispatcher = getProxyDispatcher(proxyUrl);
    this.reasoningTransport = options?.reasoningTransport ?? 'provider';
    this.extraHeaders = options?.extraHeaders;
    this.extraBody = options?.extraBody;
    this.providerOptions = options?.providerOptions;
    this.multimodal = options?.multimodal;
    this.thinking = options?.thinking;
  }

  async complete(messages: Message[], opts?: CompletionOptions): Promise<ModelResponse> {
    const body: any = {
      ...(this.extraBody || {}),
      model: this.model,
      messages: this.formatMessages(messages),
      max_tokens: opts?.maxTokens || 4096,
    };

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.system) body.system = opts.system;
    if (opts?.tools && opts.tools.length > 0) body.tools = opts.tools;

    const thinkingConfig = opts?.thinking ?? this.thinking;
    if (this.reasoningTransport === 'provider' && !body.thinking) {
      body.thinking = this.buildThinkingConfig(thinkingConfig);
    }

    const betaEntries: string[] = [];
    if (this.reasoningTransport === 'provider') {
      betaEntries.push('interleaved-thinking-2025-05-14');
    }
    if (hasAnthropicFileBlocks(messages)) {
      betaEntries.push('files-api-2025-04-14');
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      ...(this.extraHeaders || {}),
    };
    const mergedBeta = mergeAnthropicBetaHeader(headers['anthropic-beta'], betaEntries);
    if (mergedBeta) {
      headers['anthropic-beta'] = mergedBeta;
    }

    const response = await fetch(
      `${this.baseUrl}/v1/messages`,
      withProxy(
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
        this.dispatcher
      )
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const data: any = await response.json();
    const content = normalizeAnthropicContent(data.content, this.reasoningTransport);
    return {
      role: 'assistant',
      content,
      usage: data.usage,
      stop_reason: data.stop_reason,
    };
  }

  async *stream(messages: Message[], opts?: CompletionOptions): AsyncIterable<ModelStreamChunk> {
    const body: any = {
      model: this.model,
      messages: this.formatMessages(messages),
      max_tokens: opts?.maxTokens || 4096,
      stream: true,
      ...(this.extraBody || {}),
    };

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.system) body.system = opts.system;
    if (opts?.tools && opts.tools.length > 0) body.tools = opts.tools;

    const thinkingConfig = opts?.thinking ?? this.thinking;
    if (this.reasoningTransport === 'provider' && !body.thinking) {
      body.thinking = this.buildThinkingConfig(thinkingConfig);
    }

    const betaEntries: string[] = [];
    if (this.reasoningTransport === 'provider') {
      betaEntries.push('interleaved-thinking-2025-05-14');
    }
    if (hasAnthropicFileBlocks(messages)) {
      betaEntries.push('files-api-2025-04-14');
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      ...(this.extraHeaders || {}),
    };
    const mergedBeta = mergeAnthropicBetaHeader(headers['anthropic-beta'], betaEntries);
    if (mergedBeta) {
      headers['anthropic-beta'] = mergedBeta;
    }

    const response = await fetch(
      `${this.baseUrl}/v1/messages`,
      withProxy(
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
        this.dispatcher
      )
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_start') {
            const block = normalizeAnthropicContentBlock(event.content_block, this.reasoningTransport);
            if (!block) {
              continue;
            }
            yield { type: 'content_block_start', index: event.index, content_block: block };
          } else if (event.type === 'content_block_delta') {
            const delta = normalizeAnthropicDelta(event.delta);
            yield { type: 'content_block_delta', index: event.index, delta };
          } else if (event.type === 'content_block_stop') {
            yield { type: 'content_block_stop', index: event.index };
          } else if (event.type === 'message_delta') {
            yield { type: 'message_delta', delta: event.delta, usage: event.usage };
          } else if (event.type === 'message_stop') {
            yield { type: 'message_stop' };
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }

  private formatMessages(messages: Message[]): any[] {
    return messages.map((msg) => {
      const blocks = getMessageBlocks(msg);
      let degraded = false;
      const content = blocks.map((block) => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text };
        }
        if (block.type === 'reasoning') {
          if (this.reasoningTransport === 'text') {
            return { type: 'text', text: `<think>${block.reasoning}</think>` };
          }
          const result: any = { type: 'thinking', thinking: block.reasoning };
          if ((block as any).meta?.signature) {
            result.signature = (block as any).meta.signature;
          }
          return result;
        }
        if (block.type === 'image') {
          if (block.base64 && block.mime_type) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: block.mime_type,
                data: block.base64,
              },
            };
          }
          degraded = true;
          return { type: 'text', text: IMAGE_UNSUPPORTED_TEXT };
        }
        if (block.type === 'audio') {
          degraded = true;
          return { type: 'text', text: AUDIO_UNSUPPORTED_TEXT };
        }
        if (block.type === 'video') {
          degraded = true;
          return { type: 'text', text: VIDEO_UNSUPPORTED_TEXT };
        }
        if (block.type === 'file') {
          if (block.file_id) {
            return {
              type: 'document',
              source: { type: 'file', file_id: block.file_id },
            };
          }
          if (block.base64 && block.mime_type) {
            return {
              type: 'document',
              source: { type: 'base64', media_type: block.mime_type, data: block.base64 },
            };
          }
          if (block.url) {
            return {
              type: 'document',
              source: { type: 'url', url: block.url },
            };
          }
          degraded = true;
          return { type: 'text', text: FILE_UNSUPPORTED_TEXT };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          };
        }
        if (block.type === 'tool_result') {
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: formatToolResult(block.content),
            is_error: block.is_error,
          };
        }
        return block;
      });

      if (degraded) {
        markTransportIfDegraded(msg, blocks);
      }
      return {
        role: msg.role === 'system' ? 'user' : msg.role,
        content,
      };
    });
  }

  private buildThinkingConfig(thinking?: ThinkingOptions): any {
    if (!thinking?.enabled && !thinking?.budgetTokens) {
      return { type: 'enabled' };
    }
    const config: any = { type: 'enabled' };
    if (thinking?.budgetTokens) {
      config.budget_tokens = thinking.budgetTokens;
    }
    return config;
  }

  async uploadFile(input: UploadFileInput): Promise<UploadFileResult | null> {
    if (input.kind !== 'file') {
      return null;
    }
    const FormDataCtor = (globalThis as any).FormData;
    const BlobCtor = (globalThis as any).Blob;
    if (!FormDataCtor || !BlobCtor) {
      return null;
    }
    const endpoint = `${normalizeAnthropicBaseUrl(this.baseUrl)}/v1/files`;
    const form = new FormDataCtor();
    form.append('file', new BlobCtor([input.data], { type: input.mimeType }), input.filename || 'file.pdf');
    form.append('purpose', 'document');

    const response = await fetch(
      endpoint,
      withProxy(
        {
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'files-api-2025-04-14',
            ...(this.extraHeaders || {}),
          },
          body: form,
        },
        this.dispatcher
      )
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic file upload error: ${response.status} ${error}`);
    }

    const data: any = await response.json();
    const fileId = data?.id ?? data?.file_id;
    if (!fileId) {
      return null;
    }
    return { fileId };
  }

  toConfig(): ModelConfig {
    return {
      provider: 'anthropic',
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
}
