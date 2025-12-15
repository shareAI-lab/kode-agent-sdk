import { Message, ContentBlock } from '../../core/types';
import { ModelProvider, ModelResponse, ModelStreamChunk, ModelConfig } from '../provider';

export class OpenRouterProvider implements ModelProvider {
  readonly maxWindowSize = 128_000; // 根据模型调整
  readonly maxOutputTokens = 4096;
  readonly temperature = 0.7;
  readonly model: string;

  constructor(
    private apiKey: string,
    model: string = 'anthropic/claude-3.5-sonnet',
    private baseUrl: string = 'https://openrouter.ai/api/v1'
  ) {
    this.model = model;
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
      messages: this.formatMessages(messages, opts?.system),
      max_tokens: opts?.maxTokens || this.maxOutputTokens,
    };

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.tools && opts.tools.length > 0) {
      body.tools = this.formatTools(opts.tools);
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} ${error}`);
    }

    const data: any = await response.json();
    
    // 转换 OpenAI 格式到内部格式
    return {
      role: 'assistant',
      content: this.convertOpenAIContent(data.choices[0].message.content, data.choices[0].message.tool_calls),
      usage: data.usage ? {
        input_tokens: data.usage.prompt_tokens,
        output_tokens: data.usage.completion_tokens,
      } : undefined,
      stop_reason: data.choices[0].finish_reason,
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
      messages: this.formatMessages(messages, opts?.system),
      max_tokens: opts?.maxTokens || this.maxOutputTokens,
      stream: true,
    };

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
    if (opts?.tools && opts.tools.length > 0) {
      body.tools = this.formatTools(opts.tools);
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let contentBlockIndex = 0;
    let hasStartedContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          yield { type: 'message_stop' };
          continue;
        }

        try {
          const event = JSON.parse(data);
          const choice = event.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          
          // 处理内容开始
          if (delta.content && !hasStartedContent) {
            hasStartedContent = true;
            yield {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'text', text: '' }
            };
          }

          // 处理内容增量
          if (delta.content) {
            yield {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: delta.content }
            };
          }

          // 处理工具调用
          if (delta.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              if (toolCall.function?.name && !hasStartedContent) {
                hasStartedContent = true;
                yield {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: {
                    type: 'tool_use',
                    id: toolCall.id,
                    name: toolCall.function.name,
                    input: {}
                  }
                };
              }
              
              if (toolCall.function?.arguments) {
                yield {
                  type: 'content_block_delta',
                  index: contentBlockIndex,
                  delta: { type: 'input_json_delta', partial_json: toolCall.function.arguments }
                };
              }
            }
          }

          // 处理结束
          if (choice.finish_reason) {
            if (hasStartedContent) {
              yield { type: 'content_block_stop', index: contentBlockIndex };
            }
            
            if (event.usage) {
              yield {
                type: 'message_delta',
                usage: { output_tokens: event.usage.completion_tokens }
              };
            }
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
  }

  private formatMessages(messages: Message[], system?: string): any[] {
    const formatted = messages.map((msg) => ({
      role: msg.role === 'system' ? 'system' : msg.role,
      content: this.formatMessageContent(msg.content),
    }));

    // 如果有 system 消息且第一条消息不是 system，则添加
    if (system && (formatted.length === 0 || formatted[0].role !== 'system')) {
      formatted.unshift({ role: 'system', content: system });
    }

    return formatted;
  }

  private formatMessageContent(content: ContentBlock[]): string | any[] {
    if (content.length === 1 && content[0].type === 'text') {
      return content[0].text;
    }

    return content.map(block => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      } else if (block.type === 'tool_use') {
        return {
          type: 'tool_call',
          id: block.id,
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input)
          }
        };
      } else if (block.type === 'tool_result') {
        return {
          type: 'tool_call_result',
          tool_call_id: block.tool_use_id,
          content: block.content
        };
      }
      return block;
    });
  }

  private formatTools(tools: any[]): any[] {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema
      }
    }));
  }

  private convertOpenAIContent(content: string, toolCalls?: any[]): ContentBlock[] {
    const blocks: ContentBlock[] = [];

    if (content) {
      blocks.push({ type: 'text', text: content });
    }

    if (toolCalls) {
      for (const toolCall of toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments || '{}')
        });
      }
    }

    return blocks;
  }

  toConfig(): ModelConfig {
    return {
      provider: 'openrouter',
      model: this.model,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      maxTokens: this.maxOutputTokens,
      temperature: this.temperature,
    };
  }
}