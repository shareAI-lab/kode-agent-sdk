import { Message, ContentBlock } from '../core/types';
import { Configurable } from '../core/config';
import { AnthropicProvider, OpenRouterProvider } from "./providers"

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
  readonly temperature: number;

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

      return new AnthropicProvider(
        config.apiKey!,
        config.model,
        config.baseUrl
      );
    case 'openrouter':
      return new OpenRouterProvider(
        config.apiKey!,
        config.model,
        config.baseUrl
      );
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

// Export providers
export { OpenRouterProvider }
export { AnthropicProvider }