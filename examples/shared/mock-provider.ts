import type { Message, ModelConfig, ModelProvider, ModelResponse, ModelStreamChunk } from '@shareai-lab/kode-sdk';

export class MockProvider implements ModelProvider {
  readonly model = 'mock';
  readonly maxWindowSize = 200_000;
  readonly maxOutputTokens = 4096;
  readonly temperature = 0;

  constructor(private readonly text = 'Hello from the offline mock provider!') {}

  async complete(_messages: Message[]): Promise<ModelResponse> {
    return { role: 'assistant', content: [{ type: 'text', text: this.text }] };
  }

  async *stream(_messages: Message[]): AsyncIterable<ModelStreamChunk> {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: this.text } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_stop' };
  }

  toConfig(): ModelConfig {
    return { provider: 'mock', model: this.model };
  }
}
