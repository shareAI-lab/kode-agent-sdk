import { Message } from '../../core/types';
import { ModelProvider, ModelResponse, ModelStreamChunk, ModelConfig } from '../provider';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export class AnthropicProvider implements ModelProvider {
  readonly maxWindowSize = 200_000;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: AnthropicProviderOptions);
  constructor(apiKey: string, model?: string, baseUrl?: string);
  constructor(
    optionsOrApiKey: AnthropicProviderOptions | string,
    model?: string,
    baseUrl?: string
  ) {
    if (typeof optionsOrApiKey === 'string') {
      this.apiKey = optionsOrApiKey;
      this.model = model || 'claude-sonnet-4-5-20250929';
      this.baseUrl = baseUrl || 'https://api.anthropic.com';
      this.maxOutputTokens = 8192;
      this.temperature = undefined;
    } else {
      this.apiKey = optionsOrApiKey.apiKey;
      this.model = optionsOrApiKey.model || 'claude-sonnet-4-5-20250929';
      this.baseUrl = optionsOrApiKey.baseUrl || 'https://api.anthropic.com';
      this.maxOutputTokens = optionsOrApiKey.maxOutputTokens ?? 8192;
      this.temperature = optionsOrApiKey.temperature;
    }
  }

  async complete(
    messages: Message[],
    opts?: {
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      system?: string;
      stream?: boolean;
    }
  ): Promise<ModelResponse> {
    const body: any = {
      model: this.model,
      messages: this.formatMessages(messages),
      max_tokens: opts?.maxTokens ?? this.maxOutputTokens,
    };

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    } else if (this.temperature !== undefined) {
      body.temperature = this.temperature;
    }
    if (opts?.system) body.system = opts.system;
    if (opts?.tools && opts.tools.length > 0) body.tools = opts.tools;

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const data: any = await response.json();
    return {
      role: 'assistant',
      content: data.content,
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
    }
  ): AsyncIterable<ModelStreamChunk> {
    const body: any = {
      model: this.model,
      messages: this.formatMessages(messages),
      max_tokens: opts?.maxTokens ?? this.maxOutputTokens,
      stream: true,
    };

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    } else if (this.temperature !== undefined) {
      body.temperature = this.temperature;
    }
    if (opts?.system) body.system = opts.system;
    if (opts?.tools && opts.tools.length > 0) body.tools = opts.tools;

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

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
            yield { type: 'content_block_start', index: event.index, content_block: event.content_block };
          } else if (event.type === 'content_block_delta') {
            yield { type: 'content_block_delta', index: event.index, delta: event.delta };
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
    return messages.map((msg) => ({
      role: msg.role === 'system' ? 'user' : msg.role,
      content: msg.content,
    }));
  }

  toConfig(): ModelConfig {
    return {
      provider: 'anthropic',
      model: this.model,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      maxTokens: this.maxOutputTokens,
      temperature: this.temperature,
    };
  }
}
