import { Message, ContentBlock } from '../core/types';
import { Configurable } from '../core/config';
import { AnthropicProvider, AnthropicProviderOptions, OpenRouterProvider, OpenRouterProviderOptions } from './providers';

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
    type: 'text_delta' | 'input_json_delta';
    text?: string;
    partial_json?: string;
  };
  usage?: {
    output_tokens: number;
  };
}

export interface ModelConfig {
  provider: 'anthropic' | 'openrouter' | string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ModelProvider extends Configurable<ModelConfig> {
  readonly model: string;
  readonly maxWindowSize: number;
  readonly maxOutputTokens: number;
  readonly temperature?: number;

  complete(
    messages: Message[],
    opts?: {
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      system?: string;
      stream?: boolean;
    }
  ): Promise<ModelResponse>;

  stream(
    messages: Message[],
    opts?: {
      tools?: any[];
      maxTokens?: number;
      temperature?: number;
      system?: string;
    }
  ): AsyncIterable<ModelStreamChunk>;

}

// Provider factory function
export function createModelProvider(config: ModelConfig): ModelProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: config.apiKey!,
        model: config.model,
        baseUrl: config.baseUrl,
        maxOutputTokens: config.maxTokens,
        temperature: config.temperature,
      });
    case 'openrouter':
      return new OpenRouterProvider({
        apiKey: config.apiKey!,
        model: config.model,
        baseUrl: config.baseUrl,
        maxOutputTokens: config.maxTokens,
        temperature: config.temperature,
      });
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

// Re-export providers and options
export { AnthropicProvider, AnthropicProviderOptions, OpenRouterProvider, OpenRouterProviderOptions };

