import { Message, ContentBlock, ImageContentBlock, FileContentBlock } from '../core/types';
import { Configurable } from '../core/config';
import type { ThinkingOptions, ReasoningTransport, MultimodalOptions } from './providers/types';

// Re-export types from providers module for backward compatibility
export type {
  ThinkingOptions,
  ReasoningTransport,
  MultimodalOptions,
  AnthropicProviderOptions,
  OpenAIProviderOptions,
  GeminiProviderOptions,
} from './providers/types';

export interface ModelResponse {
  role: 'assistant';
  content: ContentBlock[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  stop_reason?: string;
}

export interface ModelStreamChunk {
  type: 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop';
  index?: number;
  content_block?: ContentBlock;
  delta?: {
    type: 'text_delta' | 'input_json_delta' | 'reasoning_delta';
    text?: string;
    partial_json?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens: number;
  };
}

export interface UploadFileInput {
  data: Buffer;
  mimeType: string;
  filename?: string;
  kind: 'image' | 'file';
}

export interface UploadFileResult {
  fileId?: string;
  fileUri?: string;
}

export interface ModelConfig {
  provider: 'anthropic' | 'openai' | 'gemini' | string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  proxyUrl?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningTransport?: 'omit' | 'text' | 'provider';
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  providerOptions?: Record<string, any>;
  multimodal?: {
    mode?: 'url' | 'url+base64';
    maxBase64Bytes?: number;
    allowMimeTypes?: string[];
  };
  thinking?: ThinkingOptions;
}

export interface ModelProvider extends Configurable<ModelConfig> {
  readonly model: string;
  readonly maxWindowSize: number;
  readonly maxOutputTokens: number;
  readonly temperature: number;

  complete(
    messages: Message[],
    opts?: {
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      system?: string;
      stream?: boolean;
      thinking?: ThinkingOptions;
    }
  ): Promise<ModelResponse>;

  stream(
    messages: Message[],
    opts?: {
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      system?: string;
      thinking?: ThinkingOptions;
    }
  ): AsyncIterable<ModelStreamChunk>;

  uploadFile?(input: UploadFileInput): Promise<UploadFileResult | null>;

}

export class AnthropicProvider implements ModelProvider {
  readonly maxWindowSize = 200_000;
  readonly maxOutputTokens = 4096;
  readonly temperature = 0.7;
  readonly model: string;
  private readonly dispatcher?: any;
  private readonly reasoningTransport?: ModelConfig['reasoningTransport'];
  private readonly extraHeaders?: Record<string, string>;
  private readonly extraBody?: Record<string, any>;
  private readonly providerOptions?: Record<string, any>;
  private readonly multimodal?: ModelConfig['multimodal'];

  constructor(
    private apiKey: string,
    model: string = 'claude-3-5-sonnet-20241022',
    private baseUrl: string = 'https://api.anthropic.com',
    proxyUrl?: string,
    options?: {
      reasoningTransport?: ModelConfig['reasoningTransport'];
      extraHeaders?: Record<string, string>;
      extraBody?: Record<string, any>;
      providerOptions?: Record<string, any>;
      multimodal?: ModelConfig['multimodal'];
    }
  ) {
    this.model = model;
    this.baseUrl = normalizeAnthropicBaseUrl(baseUrl);
    this.dispatcher = getProxyDispatcher(proxyUrl);
    this.reasoningTransport = options?.reasoningTransport ?? 'provider';
    this.extraHeaders = options?.extraHeaders;
    this.extraBody = options?.extraBody;
    this.providerOptions = options?.providerOptions;
    this.multimodal = options?.multimodal;
  }

  async complete(
    messages: Message[],
    opts?: {
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      system?: string;
      stream?: boolean;
      thinking?: ThinkingOptions;
    }
  ): Promise<ModelResponse> {
    const body: any = {
      ...(this.extraBody || {}),
      model: this.model,
      messages: this.formatMessages(messages),
      max_tokens: opts?.maxTokens || 4096,
    };

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.system) body.system = opts.system;
    if (opts?.tools && opts.tools.length > 0) body.tools = opts.tools;

    // Build thinking config based on ThinkingOptions
    const thinkingEnabled = opts?.thinking?.enabled ?? (this.reasoningTransport === 'provider');
    if (thinkingEnabled && !body.thinking) {
      const thinkingConfig: any = { type: 'enabled' };
      if (opts?.thinking?.budgetTokens) {
        thinkingConfig.budget_tokens = opts.thinking.budgetTokens;
      }
      body.thinking = thinkingConfig;
    }

    const betaEntries: string[] = [];
    if (thinkingEnabled) {
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

  async *stream(
    messages: Message[],
    opts?: {
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      system?: string;
      thinking?: ThinkingOptions;
    }
  ): AsyncIterable<ModelStreamChunk> {
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

    // Build thinking config based on ThinkingOptions
    const thinkingEnabled = opts?.thinking?.enabled ?? (this.reasoningTransport === 'provider');
    if (thinkingEnabled && !body.thinking) {
      const thinkingConfig: any = { type: 'enabled' };
      if (opts?.thinking?.budgetTokens) {
        thinkingConfig.budget_tokens = opts.thinking.budgetTokens;
      }
      body.thinking = thinkingConfig;
    }

    const betaEntries: string[] = [];
    if (thinkingEnabled) {
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
        } catch (e) {
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
          return { type: 'thinking', thinking: block.reasoning };
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
        if (block.type === 'file') {
          if (block.file_id) {
            return {
              type: 'document',
              source: { type: 'file', file_id: block.file_id },
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
    };
  }
}

export class OpenAIProvider implements ModelProvider {
  readonly maxWindowSize = 128_000;
  readonly maxOutputTokens = 4096;
  readonly temperature = 0.7;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly dispatcher?: any;
  private readonly reasoningTransport?: ModelConfig['reasoningTransport'];
  private readonly extraHeaders?: Record<string, string>;
  private readonly extraBody?: Record<string, any>;
  private readonly providerOptions?: Record<string, any>;
  private readonly multimodal?: ModelConfig['multimodal'];
  private readonly providerName: string;
  private readonly openaiApi: 'chat' | 'responses';

  constructor(
    private apiKey: string,
    model: string = 'gpt-4o',
    baseUrl: string = 'https://api.openai.com/v1',
    proxyUrl?: string,
    options?: {
      providerName?: string;
      reasoningTransport?: ModelConfig['reasoningTransport'];
      extraHeaders?: Record<string, string>;
      extraBody?: Record<string, any>;
      providerOptions?: Record<string, any>;
      multimodal?: ModelConfig['multimodal'];
    }
  ) {
    this.model = model;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.dispatcher = getProxyDispatcher(proxyUrl);
    this.providerName = options?.providerName ?? 'openai';
    this.reasoningTransport =
      options?.reasoningTransport ??
      (this.providerName === 'openai' || this.providerName === 'gemini' ? 'text' : 'provider');
    this.extraHeaders = options?.extraHeaders;
    this.extraBody = options?.extraBody;
    this.providerOptions = options?.providerOptions;
    this.multimodal = options?.multimodal;
    this.openaiApi = (this.providerOptions?.openaiApi as 'chat' | 'responses') || 'chat';
  }

  private applyReasoningDefaults(body: any): void {
    if (this.reasoningTransport !== 'provider') {
      return;
    }
    if (this.providerName === 'glm') {
      if (!body.thinking) {
        body.thinking = { type: 'enabled', clear_thinking: false };
      }
    }
    if (this.providerName === 'minimax') {
      if (body.reasoning_split === undefined) {
        body.reasoning_split = true;
      }
    }
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
    const form = new FormDataCtor();
    form.append('file', new BlobCtor([input.data], { type: input.mimeType }), input.filename || 'file.pdf');
    const purpose = (this.providerOptions?.fileUploadPurpose as string) || 'assistants';
    form.append('purpose', purpose);

    const response = await fetch(
      `${this.baseUrl}/files`,
      withProxy(
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(this.extraHeaders || {}),
          },
          body: form,
        },
        this.dispatcher
      )
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI file upload error: ${response.status} ${error}`);
    }

    const data: any = await response.json();
    const fileId = data?.id ?? data?.file_id;
    if (!fileId) {
      return null;
    }
    return { fileId };
  }

  async complete(
    messages: Message[],
    opts?: {
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      system?: string;
      stream?: boolean;
      thinking?: ThinkingOptions;
    }
  ): Promise<ModelResponse> {
    const responseApi = this.resolveOpenAIApi(messages);
    if (responseApi === 'responses') {
      return this.completeWithResponses(messages, opts);
    }

    const body: any = {
      ...(this.extraBody || {}),
      model: this.model,
      messages: buildOpenAIMessages(messages, opts?.system, this.reasoningTransport, this.providerName),
    };

    if (opts?.tools && opts.tools.length > 0) {
      body.tools = buildOpenAITools(opts.tools);
    }
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    this.applyReasoningDefaults(body);

    const response = await fetch(
      `${this.baseUrl}/chat/completions`,
      withProxy(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            ...(this.extraHeaders || {}),
          },
          body: JSON.stringify(body),
        },
        this.dispatcher
      )
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const data: any = await response.json();
    const message = data.choices?.[0]?.message ?? {};
    const contentBlocks: ContentBlock[] = [];
    const text = typeof message.content === 'string' ? message.content : '';
    if (text) {
      contentBlocks.push({ type: 'text', text });
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of toolCalls) {
      const args = call?.function?.arguments;
      let input: any = {};
      if (typeof args === 'string') {
        try {
          input = JSON.parse(args);
        } catch {
          input = { raw: args };
        }
      }
      contentBlocks.push({
        type: 'tool_use',
        id: call.id,
        name: call?.function?.name ?? 'tool',
        input,
      });
    }

    const reasoningBlocks = extractReasoningDetails(message);
    const combinedBlocks =
      reasoningBlocks.length > 0 ? [...reasoningBlocks, ...contentBlocks] : contentBlocks;

    const normalizedBlocks = normalizeThinkBlocks(combinedBlocks, this.reasoningTransport);
    return {
      role: 'assistant',
      content: normalizedBlocks,
      usage: data.usage
        ? {
            input_tokens: data.usage.prompt_tokens ?? 0,
            output_tokens: data.usage.completion_tokens ?? 0,
          }
        : undefined,
      stop_reason: data.choices?.[0]?.finish_reason,
    };
  }

  async *stream(
    messages: Message[],
    opts?: {
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      system?: string;
      thinking?: ThinkingOptions;
    }
  ): AsyncIterable<ModelStreamChunk> {
    const responseApi = this.resolveOpenAIApi(messages);
    if (responseApi === 'responses') {
      const response = await this.completeWithResponses(messages, opts);
      let index = 0;
      for (const block of response.content) {
        if (block.type === 'text') {
          yield { type: 'content_block_start', index, content_block: { type: 'text', text: '' } };
          if (block.text) {
            yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } };
          }
          yield { type: 'content_block_stop', index };
          index += 1;
          continue;
        }
        if (block.type === 'reasoning') {
          yield { type: 'content_block_start', index, content_block: { type: 'reasoning', reasoning: '' } };
          if (block.reasoning) {
            yield { type: 'content_block_delta', index, delta: { type: 'reasoning_delta', text: block.reasoning } };
          }
          yield { type: 'content_block_stop', index };
          index += 1;
        }
      }
      if (response.usage) {
        yield {
          type: 'message_delta',
          usage: {
            input_tokens: response.usage.input_tokens ?? 0,
            output_tokens: response.usage.output_tokens ?? 0,
          },
        };
      }
      yield { type: 'message_stop' };
      return;
    }

    const body: any = {
      ...(this.extraBody || {}),
      model: this.model,
      messages: buildOpenAIMessages(messages, opts?.system, this.reasoningTransport, this.providerName),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (opts?.tools && opts.tools.length > 0) {
      body.tools = buildOpenAITools(opts.tools);
    }
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    this.applyReasoningDefaults(body);

    const response = await fetch(
      `${this.baseUrl}/chat/completions`,
      withProxy(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            ...(this.extraHeaders || {}),
          },
          body: JSON.stringify(body),
        },
        this.dispatcher
      )
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let textStarted = false;
    const textIndex = 0;
    let reasoningStarted = false;
    const reasoningIndex = 1000;
    let sawFinishReason = false;
    let usageEmitted = false;
    const toolCallBuffers = new Map<number, { id?: string; name?: string; args: string }>();

    function* flushToolCalls(): Generator<ModelStreamChunk> {
      if (toolCallBuffers.size === 0) return;
      const entries = Array.from(toolCallBuffers.entries()).sort((a, b) => a[0] - b[0]);
      for (const [index, call] of entries) {
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: call.id ?? `toolcall-${index}`,
            name: call.name ?? 'tool',
            input: {},
          },
        };
        if (call.args) {
          yield {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: call.args },
          };
        }
        yield { type: 'content_block_stop', index };
      }
      toolCallBuffers.clear();
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        const choice = event.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content.length > 0) {
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
            delta: { type: 'text_delta', text: delta.content },
          };
        }

        if (typeof (delta as any).reasoning_content === 'string') {
          const reasoningText = (delta as any).reasoning_content;
          if (!reasoningStarted) {
            reasoningStarted = true;
            yield {
              type: 'content_block_start',
              index: reasoningIndex,
              content_block: { type: 'reasoning', reasoning: '' },
            };
          }
          yield {
            type: 'content_block_delta',
            index: reasoningIndex,
            delta: { type: 'reasoning_delta', text: reasoningText },
          };
        }

        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const call of toolCalls) {
          const index = typeof call.index === 'number' ? call.index : 0;
          const entry = toolCallBuffers.get(index) ?? { args: '' };
          if (call.id) entry.id = call.id;
          if (call.function?.name) entry.name = call.function.name;
          if (typeof call.function?.arguments === 'string') {
            entry.args += call.function.arguments;
          }
          toolCallBuffers.set(index, entry);
        }

        if (event.usage && !usageEmitted) {
          usageEmitted = true;
          yield {
            type: 'message_delta',
            usage: {
              input_tokens: event.usage.prompt_tokens ?? 0,
              output_tokens: event.usage.completion_tokens ?? 0,
            },
          };
        }

        if (choice.finish_reason) {
          sawFinishReason = true;
        }
      }
    }

    if (textStarted) {
      yield { type: 'content_block_stop', index: textIndex };
    }
    if (reasoningStarted) {
      yield { type: 'content_block_stop', index: reasoningIndex };
    }
    if (toolCallBuffers.size > 0) {
      yield* flushToolCalls();
    }
    if (sawFinishReason && !usageEmitted) {
      yield {
        type: 'message_delta',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }
  }

  toConfig(): ModelConfig {
    return {
      provider: this.providerName,
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
    };
  }

  private resolveOpenAIApi(messages: Message[]): 'chat' | 'responses' {
    if (this.openaiApi !== 'responses') {
      return 'chat';
    }
    const hasFile = messages.some((message) =>
      getMessageBlocks(message).some((block) => block.type === 'file')
    );
    return hasFile ? 'responses' : 'chat';
  }

  private async completeWithResponses(
    messages: Message[],
    opts?: {
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      system?: string;
      stream?: boolean;
      thinking?: ThinkingOptions;
    }
  ): Promise<ModelResponse> {
    const input = buildOpenAIResponsesInput(messages, this.reasoningTransport);
    const body: any = {
      ...(this.extraBody || {}),
      model: this.model,
      input,
    };

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) body.max_output_tokens = opts.maxTokens;
    if (opts?.system) body.instructions = opts.system;

    // Apply reasoning_effort from ThinkingOptions for Responses API
    if (opts?.thinking?.effort) {
      body.reasoning = { effort: opts.thinking.effort };
    }

    this.applyReasoningDefaults(body);

    const response = await fetch(
      `${this.baseUrl}/responses`,
      withProxy(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            ...(this.extraHeaders || {}),
          },
          body: JSON.stringify(body),
        },
        this.dispatcher
      )
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    const data: any = await response.json();
    const contentBlocks: ContentBlock[] = [];
    const outputs = Array.isArray(data.output) ? data.output : [];
    for (const output of outputs) {
      const parts = output?.content || [];
      for (const part of parts) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          contentBlocks.push({ type: 'text', text: part.text });
        }
      }
    }

    const normalizedBlocks = normalizeThinkBlocks(contentBlocks, this.reasoningTransport);
    return {
      role: 'assistant',
      content: normalizedBlocks,
      usage: data.usage
        ? {
            input_tokens: data.usage.input_tokens ?? 0,
            output_tokens: data.usage.output_tokens ?? 0,
          }
        : undefined,
      stop_reason: data.status,
    };
  }
}

export class GeminiProvider implements ModelProvider {
  readonly maxWindowSize = 1_000_000;
  readonly maxOutputTokens = 4096;
  readonly temperature = 0.7;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly dispatcher?: any;
  private readonly reasoningTransport?: ModelConfig['reasoningTransport'];
  private readonly extraHeaders?: Record<string, string>;
  private readonly extraBody?: Record<string, any>;
  private readonly providerOptions?: Record<string, any>;
  private readonly multimodal?: ModelConfig['multimodal'];

  constructor(
    private apiKey: string,
    model: string = 'gemini-3.0-flash',
    baseUrl: string = 'https://generativelanguage.googleapis.com/v1beta',
    proxyUrl?: string,
    options?: {
      reasoningTransport?: ModelConfig['reasoningTransport'];
      extraHeaders?: Record<string, string>;
      extraBody?: Record<string, any>;
      providerOptions?: Record<string, any>;
      multimodal?: ModelConfig['multimodal'];
    }
  ) {
    this.model = model;
    this.baseUrl = normalizeGeminiBaseUrl(baseUrl);
    this.dispatcher = getProxyDispatcher(proxyUrl);
    this.reasoningTransport = options?.reasoningTransport ?? 'text';
    this.extraHeaders = options?.extraHeaders;
    this.extraBody = options?.extraBody;
    this.providerOptions = options?.providerOptions;
    this.multimodal = options?.multimodal;
  }

  async uploadFile(input: UploadFileInput): Promise<UploadFileResult | null> {
    if (input.kind !== 'file') {
      return null;
    }
    const url = new URL(`${this.baseUrl}/files`);
    url.searchParams.set('key', this.apiKey);
    const body = {
      file: {
        display_name: input.filename || 'file.pdf',
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

  async complete(
    messages: Message[],
    opts?: {
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      system?: string;
      stream?: boolean;
      thinking?: ThinkingOptions;
    }
  ): Promise<ModelResponse> {
    const body: any = {
      ...(this.extraBody || {}),
      ...buildGeminiRequestBody(messages, {
      system: opts?.system,
      tools: opts?.tools,
      maxTokens: opts?.maxTokens ?? this.maxOutputTokens,
      temperature: opts?.temperature ?? this.temperature,
      reasoningTransport: this.reasoningTransport,
      thinking: opts?.thinking,
    }),
    };

    const url = buildGeminiUrl(this.baseUrl, this.model, 'generateContent', this.apiKey);
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
      extractGeminiContentBlocks(candidate?.content),
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

  async *stream(
    messages: Message[],
    opts?: {
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      system?: string;
      thinking?: ThinkingOptions;
    }
  ): AsyncIterable<ModelStreamChunk> {
    const body: any = {
      ...(this.extraBody || {}),
      ...buildGeminiRequestBody(messages, {
      system: opts?.system,
      tools: opts?.tools,
      maxTokens: opts?.maxTokens ?? this.maxOutputTokens,
      temperature: opts?.temperature ?? this.temperature,
      reasoningTransport: this.reasoningTransport,
      thinking: opts?.thinking,
    }),
    };

    const url = buildGeminiUrl(this.baseUrl, this.model, 'streamGenerateContent', this.apiKey);
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

        const { textChunks, functionCalls, usage } = parseGeminiChunk(event);
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
          const { textChunks, functionCalls, usage } = parseGeminiChunk(event);
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
    };
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
}

function hasAnthropicFileBlocks(messages: Message[]): boolean {
  for (const msg of messages) {
    for (const block of getMessageBlocks(msg)) {
      if (block.type === 'file' && block.file_id) {
        return true;
      }
    }
  }
  return false;
}

function mergeAnthropicBetaHeader(existing: string | undefined, entries: string[]): string | undefined {
  const tokens = new Set<string>();
  if (existing) {
    for (const part of existing.split(',')) {
      const trimmed = part.trim();
      if (trimmed) tokens.add(trimmed);
    }
  }
  for (const entry of entries) {
    if (entry) tokens.add(entry);
  }
  if (tokens.size === 0) return existing;
  return Array.from(tokens).join(',');
}

function buildOpenAITools(tools: any[]): any[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

function buildOpenAIMessages(
  messages: Message[],
  system?: string,
  reasoningTransport: ModelConfig['reasoningTransport'] = 'text',
  providerName: string = 'openai'
): any[] {
  const output: any[] = [];
  const toolCallNames = new Map<string, string>();
  const useStructuredContent = messages.some((msg) =>
    getMessageBlocks(msg).some((block) => block.type === 'image' || block.type === 'audio' || block.type === 'file')
  );

  for (const msg of messages) {
    for (const block of getMessageBlocks(msg)) {
      if (block.type === 'tool_use') {
        toolCallNames.set(block.id, block.name);
      }
    }
  }

  if (system) {
    output.push({
      role: 'system',
      content: useStructuredContent ? [{ type: 'text', text: system }] : system,
    });
  }

  for (const msg of messages) {
    const blocks = getMessageBlocks(msg);
    if (msg.role === 'system') {
      const text = concatTextWithReasoning(blocks, reasoningTransport);
      if (text) {
        output.push({
          role: 'system',
          content: useStructuredContent ? [{ type: 'text', text }] : text,
        });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const text = concatTextWithReasoning(blocks, reasoningTransport);
      const toolCalls = blocks.filter((block) => block.type === 'tool_use') as Array<{
        id: string;
        name: string;
        input: any;
      }>;
      const reasoningBlocks = blocks.filter((block) => block.type === 'reasoning');

      const entry: any = { role: 'assistant' };
      if (text) {
        entry.content = useStructuredContent ? [{ type: 'text', text }] : text;
      }
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: safeJsonStringify(call.input ?? {}),
          },
        }));
        if (!entry.content) entry.content = null;
      }
      if (reasoningTransport === 'provider' && reasoningBlocks.length > 0) {
        if (providerName === 'glm') {
          entry.reasoning_content = joinReasoningBlocks(reasoningBlocks);
        } else if (providerName === 'minimax') {
          entry.reasoning_details = reasoningBlocks.map((block: any) => ({ text: block.reasoning }));
        }
      }

      if (entry.content !== undefined || entry.tool_calls || entry.reasoning_content || entry.reasoning_details) {
        output.push(entry);
      }
      continue;
    }

    if (msg.role === 'user') {
      const result = buildOpenAIUserMessages(blocks, toolCallNames, reasoningTransport);
      if (result.degraded) {
        markTransportIfDegraded(msg, blocks);
      }
      for (const entry of result.entries) {
        output.push(entry);
      }
    }
  }

  return output;
}

function normalizeGeminiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, '');
    const hasVersion = /(^|\/)v1(beta)?(\/|$)/.test(path);
    if (!path || path === '/') {
      url.pathname = '/v1beta';
    } else if (hasVersion) {
      url.pathname = path;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed;
  }
}

function buildGeminiUrl(baseUrl: string, model: string, action: 'generateContent' | 'streamGenerateContent', apiKey: string): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/models/${model}:${action}`);
  url.searchParams.set('key', apiKey);
  if (action === 'streamGenerateContent') {
    url.searchParams.set('alt', 'sse');
  }
  return url;
}

function buildGeminiRequestBody(
  messages: Message[],
  opts: {
    system?: string;
    tools?: any[];
    maxTokens?: number;
    temperature?: number;
    reasoningTransport?: ModelConfig['reasoningTransport'];
    thinking?: ThinkingOptions;
  }
): any {
  const systemInstruction = buildGeminiSystemInstruction(messages, opts.system, opts.reasoningTransport);
  const contents = buildGeminiContents(messages, opts.reasoningTransport);
  const tools = opts.tools && opts.tools.length > 0 ? buildGeminiTools(opts.tools) : undefined;

  const generationConfig: any = {};
  if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) generationConfig.maxOutputTokens = opts.maxTokens;

  // Apply thinking options for Gemini
  // - For Gemini 2.5 models: use thinkingBudget (token count)
  // - For Gemini 3.x models: use thinkingLevel ('none' | 'low' | 'medium' | 'high')
  if (opts.thinking?.budgetTokens !== undefined) {
    generationConfig.thinkingBudget = opts.thinking.budgetTokens;
  }
  if (opts.thinking?.level !== undefined) {
    generationConfig.thinkingLevel = opts.thinking.level.toUpperCase();
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

function buildGeminiSystemInstruction(
  messages: Message[],
  system?: string,
  reasoningTransport: ModelConfig['reasoningTransport'] = 'text'
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

function buildGeminiContents(
  messages: Message[],
  reasoningTransport: ModelConfig['reasoningTransport'] = 'text'
): any[] {
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
        degraded = true;
        parts.push({ text: AUDIO_UNSUPPORTED_TEXT });
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
            args: normalizeGeminiArgs(block.input),
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
            response: { content: formatGeminiToolResult(block.content) },
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

function buildGeminiTools(tools: any[]): any[] {
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

function normalizeGeminiArgs(input: any): Record<string, any> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input;
  }
  return { value: input };
}

function formatGeminiToolResult(content: any): string {
  if (typeof content === 'string') return content;
  return safeJsonStringify(content);
}

function extractGeminiContentBlocks(content: any): ContentBlock[] {
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

function parseGeminiChunk(event: any): {
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

function sanitizeGeminiSchema(schema: any): any {
  if (schema === null || schema === undefined) return schema;
  if (Array.isArray(schema)) return schema.map((item) => sanitizeGeminiSchema(item));
  if (typeof schema !== 'object') return schema;

  const cleaned: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema' || key === '$defs' || key === 'definitions') {
      continue;
    }
    cleaned[key] = sanitizeGeminiSchema(value);
  }
  return cleaned;
}

const proxyAgents = new Map<string, any>();

function resolveProxyUrl(explicit?: string): string | undefined {
  if (explicit) return explicit;
  const flag = process.env.KODE_USE_ENV_PROXY;
  if (!flag || ['0', 'false', 'no'].includes(flag.toLowerCase())) {
    return undefined;
  }
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  );
}

function getProxyDispatcher(proxyUrl?: string): any | undefined {
  const resolved = resolveProxyUrl(proxyUrl);
  if (!resolved) return undefined;
  const cached = proxyAgents.get(resolved);
  if (cached) return cached;
  let ProxyAgent: any;
  try {
    ({ ProxyAgent } = require('undici'));
  } catch (error: any) {
    throw new Error(`Proxy support requires undici. Install it to use proxyUrl (${error?.message || error}).`);
  }
  const agent = new ProxyAgent(resolved);
  proxyAgents.set(resolved, agent);
  return agent;
}

function withProxy(init: RequestInit, dispatcher?: any): RequestInit {
  if (!dispatcher) return init;
  return { ...init, dispatcher } as any;
}

function joinTextBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function formatToolResult(content: any): string {
  if (typeof content === 'string') return content;
  return safeJsonStringify(content);
}

function safeJsonStringify(value: any): string {
  try {
    const json = JSON.stringify(value ?? {});
    return json === undefined ? '{}' : json;
  } catch {
    return '{}';
  }
}

const FILE_UNSUPPORTED_TEXT =
  '[file unsupported] This model does not support PDF input. Please extract text or images first.';
const IMAGE_UNSUPPORTED_TEXT =
  '[image unsupported] This model does not support image URLs; please provide base64 data if supported.';
const AUDIO_UNSUPPORTED_TEXT =
  '[audio unsupported] This model does not support audio input; please provide a text transcript instead.';

function markTransportIfDegraded(message: Message, blocks: ContentBlock[]): void {
  if (message.metadata?.transport === 'omit') {
    return;
  }
  if (!message.metadata) {
    message.metadata = { content_blocks: blocks, transport: 'text' };
    return;
  }
  if (!message.metadata.content_blocks) {
    message.metadata.content_blocks = blocks;
  }
  message.metadata.transport = 'text';
}

function getMessageBlocks(message: Message): ContentBlock[] {
  if (message.metadata?.transport === 'omit') {
    return message.content;
  }
  return message.metadata?.content_blocks ?? message.content;
}

function concatTextWithReasoning(
  blocks: ContentBlock[],
  reasoningTransport: ModelConfig['reasoningTransport'] = 'text'
): string {
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'reasoning' && reasoningTransport === 'text') {
      text += `<think>${block.reasoning}</think>`;
    }
  }
  return text;
}

function joinReasoningBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
    .map((block) => block.reasoning)
    .join('\n');
}

function normalizeThinkBlocks(
  blocks: ContentBlock[],
  reasoningTransport: ModelConfig['reasoningTransport'] = 'text'
): ContentBlock[] {
  if (reasoningTransport !== 'text') {
    return blocks;
  }
  const output: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type !== 'text') {
      output.push(block);
      continue;
    }
    const parts = splitThinkText(block.text);
    if (parts.length === 0) {
      output.push(block);
    } else {
      output.push(...parts);
    }
  }
  return output;
}

function splitThinkText(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const regex = /<think>([\s\S]*?)<\/think>/g;
  let match: RegExpExecArray | null;
  let cursor = 0;
  let matched = false;

  while ((match = regex.exec(text)) !== null) {
    matched = true;
    const before = text.slice(cursor, match.index);
    if (before) {
      blocks.push({ type: 'text', text: before });
    }
    const reasoning = match[1] || '';
    blocks.push({ type: 'reasoning', reasoning });
    cursor = match.index + match[0].length;
  }

  if (!matched) {
    return [];
  }

  const after = text.slice(cursor);
  if (after) {
    blocks.push({ type: 'text', text: after });
  }
  return blocks;
}

function extractReasoningDetails(message: any): ContentBlock[] {
  const details = Array.isArray(message?.reasoning_details) ? message.reasoning_details : [];
  const content = typeof message?.reasoning_content === 'string' ? message.reasoning_content : undefined;
  const blocks: ContentBlock[] = [];
  for (const detail of details) {
    if (typeof detail?.text === 'string') {
      blocks.push({ type: 'reasoning', reasoning: detail.text });
    }
  }
  if (content) {
    blocks.push({ type: 'reasoning', reasoning: content });
  }
  return blocks;
}

function buildOpenAIUserMessages(
  blocks: ContentBlock[],
  toolCallNames: Map<string, string>,
  reasoningTransport: ModelConfig['reasoningTransport'] = 'text'
): { entries: any[]; degraded: boolean } {
  const entries: any[] = [];
  let contentParts: any[] = [];
  let degraded = false;

  const appendText = (text: string) => {
    if (!text) return;
    const last = contentParts[contentParts.length - 1];
    if (last && last.type === 'text') {
      last.text += text;
    } else {
      contentParts.push({ type: 'text', text });
    }
  };

  const flushUser = () => {
    if (contentParts.length === 0) return;
    entries.push({ role: 'user', content: contentParts });
    contentParts = [];
  };

  for (const block of blocks) {
    if (block.type === 'text') {
      appendText(block.text);
      continue;
    }
    if (block.type === 'reasoning') {
      if (reasoningTransport === 'text') {
        appendText(`<think>${block.reasoning}</think>`);
      }
      continue;
    }
    if (block.type === 'image') {
      if (block.url) {
        contentParts.push({ type: 'image_url', image_url: { url: block.url } });
      } else if (block.base64 && block.mime_type) {
        contentParts.push({
          type: 'image_url',
          image_url: { url: `data:${block.mime_type};base64,${block.base64}` },
        });
      } else {
        degraded = true;
        appendText(IMAGE_UNSUPPORTED_TEXT);
      }
      continue;
    }
    if (block.type === 'audio') {
      degraded = true;
      appendText(AUDIO_UNSUPPORTED_TEXT);
      continue;
    }
    if (block.type === 'file') {
      degraded = true;
      appendText(FILE_UNSUPPORTED_TEXT);
      continue;
    }
    if (block.type === 'tool_result') {
      flushUser();
      const toolMessage: any = {
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: formatToolResult(block.content),
      };
      const name = toolCallNames.get(block.tool_use_id);
      if (name) toolMessage.name = name;
      entries.push(toolMessage);
      continue;
    }
  }

  flushUser();
  return { entries, degraded };
}

function buildOpenAIResponsesInput(
  messages: Message[],
  reasoningTransport: ModelConfig['reasoningTransport'] = 'text'
): any[] {
  const input: any[] = [];
  for (const msg of messages) {
    const blocks = getMessageBlocks(msg);
    const parts: any[] = [];
    let degraded = false;
    const textType = msg.role === 'assistant' ? 'output_text' : 'input_text';
    for (const block of blocks) {
      if (block.type === 'text') {
        parts.push({ type: textType, text: block.text });
      } else if (block.type === 'reasoning' && reasoningTransport === 'text') {
        parts.push({ type: textType, text: `<think>${block.reasoning}</think>` });
      } else if (block.type === 'audio') {
        degraded = true;
        parts.push({ type: textType, text: AUDIO_UNSUPPORTED_TEXT });
      } else if (block.type === 'file') {
        if ((block as any).file_id) {
          parts.push({ type: 'input_file', file_id: (block as any).file_id });
        } else if (block.url) {
          parts.push({ type: 'input_file', file_url: block.url });
        } else if (block.base64 && block.mime_type) {
          parts.push({
            type: 'input_file',
            filename: block.filename || 'file.pdf',
            file_data: `data:${block.mime_type};base64,${block.base64}`,
          });
        } else {
          degraded = true;
          parts.push({ type: textType, text: FILE_UNSUPPORTED_TEXT });
        }
      }
    }
    if (degraded) {
      markTransportIfDegraded(msg, blocks);
    }
    if (parts.length > 0) {
      input.push({ role: msg.role, content: parts });
    }
  }
  return input;
}

function buildGeminiImagePart(block: ImageContentBlock): any | null {
  if (block.file_id) {
    return { file_data: { mime_type: block.mime_type, file_uri: block.file_id } };
  }
  if (block.url) {
    if (block.url.startsWith('gs://')) {
      return { file_data: { mime_type: block.mime_type, file_uri: block.url } };
    }
    return null;
  }
  if (block.base64 && block.mime_type) {
    return { inline_data: { mime_type: block.mime_type, data: block.base64 } };
  }
  return null;
}

function buildGeminiFilePart(block: FileContentBlock): any | null {
  const mimeType = block.mime_type || 'application/pdf';
  if (block.file_id) {
    return { file_data: { mime_type: mimeType, file_uri: block.file_id } };
  }
  if (block.url) {
    if (block.url.startsWith('gs://')) {
      return { file_data: { mime_type: mimeType, file_uri: block.url } };
    }
    return null;
  }
  if (block.base64) {
    return { inline_data: { mime_type: mimeType, data: block.base64 } };
  }
  return null;
}

function normalizeAnthropicContent(content: any[], reasoningTransport?: ModelConfig['reasoningTransport']): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    const normalized = normalizeAnthropicContentBlock(block, reasoningTransport);
    if (normalized) blocks.push(normalized);
  }
  return blocks;
}

function normalizeAnthropicContentBlock(
  block: any,
  reasoningTransport?: ModelConfig['reasoningTransport']
): ContentBlock | null {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'thinking') {
    if (reasoningTransport === 'text') {
      return { type: 'text', text: `<think>${block.thinking ?? ''}</think>` };
    }
    return { type: 'reasoning', reasoning: block.thinking ?? '' };
  }
  if (block.type === 'text') {
    return { type: 'text', text: block.text ?? '' };
  }
  if (block.type === 'image' && block.source?.type === 'base64') {
    return {
      type: 'image',
      base64: block.source.data,
      mime_type: block.source.media_type,
    };
  }
  if (block.type === 'document' && block.source?.type === 'file') {
    return {
      type: 'file',
      file_id: block.source.file_id,
      mime_type: block.source.media_type,
    };
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
      content: block.content,
      is_error: block.is_error,
    };
  }
  return null;
}

function normalizeAnthropicDelta(delta: any): { type: 'text_delta' | 'input_json_delta' | 'reasoning_delta'; text?: string; partial_json?: string } {
  if (!delta) {
    return { type: 'text_delta', text: '' };
  }
  if (delta.type === 'thinking_delta') {
    return { type: 'reasoning_delta', text: delta.thinking ?? '' };
  }
  if (delta.type === 'input_json_delta') {
    return { type: 'input_json_delta', partial_json: delta.partial_json ?? '' };
  }
  return { type: 'text_delta', text: delta.text ?? '' };
}
