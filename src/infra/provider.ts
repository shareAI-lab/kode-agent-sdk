import { Message, ContentBlock } from '../core/types';
import { Configurable } from '../core/config';

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
  provider: 'anthropic' | string;
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

export class AnthropicProvider implements ModelProvider {
  readonly maxWindowSize = 200_000;
  readonly maxOutputTokens = 4096;
  readonly temperature = 0.7;
  readonly model: string;

  constructor(
    private apiKey: string,
    model: string = 'claude-3-5-sonnet-20241022',
    private baseUrl: string = 'https://api.anthropic.com'
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
      messages: this.formatMessages(messages),
      max_tokens: opts?.maxTokens || 4096,
    };

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
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
      max_tokens: opts?.maxTokens || 4096,
      stream: true,
    };

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;
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
        } catch (e) {
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

export class OpenRouterProvider implements ModelProvider {
  readonly maxWindowSize = 200_000;
  readonly maxOutputTokens = 4096;
  readonly temperature = 0.7;
  readonly model: string;

  constructor(
    private apiKey: string,
    model: string,
    private baseUrl: string = 'https://openrouter.ai/api/v1',
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
      messages: toOpenAIChatMessages(messages, opts?.system),
    };

    const maxTokens = opts?.maxTokens ?? this.maxOutputTokens;
    if (typeof maxTokens === 'number') body.max_tokens = maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const tools = toOpenAITools(opts?.tools);
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${stripTrailingSlash(this.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} ${error}`);
    }

    const data: any = await response.json();
    const msg = data?.choices?.[0]?.message;
    const blocks = openAIMessageToContentBlocks(msg);

    return {
      role: 'assistant',
      content: blocks,
      usage: data?.usage
        ? {
            input_tokens: data.usage.prompt_tokens ?? 0,
            output_tokens: data.usage.completion_tokens ?? 0,
          }
        : undefined,
      stop_reason: data?.choices?.[0]?.finish_reason,
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
      messages: toOpenAIChatMessages(messages, opts?.system),
      stream: true,
      stream_options: { include_usage: true },
    };

    const maxTokens = opts?.maxTokens ?? this.maxOutputTokens;
    if (typeof maxTokens === 'number') body.max_tokens = maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const tools = toOpenAITools(opts?.tools);
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    // Retry logic for rate limiting (429) errors
    const MAX_RETRIES = 3;
    let lastError: Error | null = null;
    let response: Response | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        response = await fetch(`${stripTrailingSlash(this.baseUrl)}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          break; // Success, exit retry loop
        }

        const errorText = await response.text();

        // Only retry on 429 (rate limit) errors
        if (response.status === 429 && attempt < MAX_RETRIES - 1) {
          // Parse retry-after header or use exponential backoff
          const retryAfter = response.headers.get('retry-after');
          const waitTime = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff, max 10s

          console.warn(`[OpenRouter] Rate limited (429), retrying in ${waitTime}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }

        // Non-retryable error or max retries reached
        throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt === MAX_RETRIES - 1) {
          throw lastError;
        }
      }
    }

    if (!response || !response.ok) {
      throw lastError || new Error('OpenRouter API request failed');
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    let textBlockIndex: number | null = null;
    let nextContentBlockIndex = 0;

    const toolIndexToContentIndex = new Map<number, number>();
    const toolStates = new Map<
      number,
      {
        started: boolean;
        id?: string;
        name?: string;
        pendingArgs: string[];
        startedIndex?: number;
      }
    >();

    const ensureTextStarted = () => {
      if (textBlockIndex !== null) return;
      textBlockIndex = nextContentBlockIndex++;
      const index = textBlockIndex;
      // Agent expects a start event before deltas
      const content_block: ContentBlock = { type: 'text', text: '' };
      return { index, content_block };
    };

    const ensureToolContentIndex = (openAiToolIndex: number): number => {
      const existing = toolIndexToContentIndex.get(openAiToolIndex);
      if (existing !== undefined) return existing;
      const idx = nextContentBlockIndex++;
      toolIndexToContentIndex.set(openAiToolIndex, idx);
      return idx;
    };

    const tryStartTool = (openAiToolIndex: number) => {
      const state = toolStates.get(openAiToolIndex);
      if (!state || state.started) return;
      const name = state.name;
      if (!name) return;
      const id = state.id ?? `toolu_${openAiToolIndex}_${Date.now()}`;
      state.id = id;
      state.started = true;
      const contentIndex = ensureToolContentIndex(openAiToolIndex);
      state.startedIndex = contentIndex;
      const content_block: ContentBlock = {
        type: 'tool_use',
        id,
        name,
        input: {},
      };
      return { contentIndex, content_block };
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data:')) continue;
          const data = line.replace(/^data:\s*/, '');
          if (data === '[DONE]') continue;

          let event: any;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          const choice = event?.choices?.[0];
          const delta = choice?.delta;

          // Text streaming
          if (typeof delta?.content === 'string' && delta.content.length > 0) {
            const started = ensureTextStarted();
            if (started) {
              yield { type: 'content_block_start', index: started.index, content_block: started.content_block };
            }
            yield {
              type: 'content_block_delta',
              index: textBlockIndex ?? 0,
              delta: { type: 'text_delta', text: delta.content },
            };
          }

          // Tool call streaming
          const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
          for (const toolCall of toolCalls) {
            const openAiToolIndex: number = typeof toolCall?.index === 'number' ? toolCall.index : 0;
            const state = toolStates.get(openAiToolIndex) ?? {
              started: false,
              pendingArgs: [],
            };

            if (typeof toolCall?.id === 'string') state.id = toolCall.id;
            if (typeof toolCall?.function?.name === 'string') state.name = toolCall.function.name;
            if (typeof toolCall?.function?.arguments === 'string' && toolCall.function.arguments.length > 0) {
              state.pendingArgs.push(toolCall.function.arguments);
            }

            toolStates.set(openAiToolIndex, state);

            const startedTool = tryStartTool(openAiToolIndex);
            if (startedTool) {
              yield {
                type: 'content_block_start',
                index: startedTool.contentIndex,
                content_block: startedTool.content_block,
              };
            }

            if (state.started) {
              const idx = state.startedIndex ?? ensureToolContentIndex(openAiToolIndex);
              while (state.pendingArgs.length > 0) {
                const partial_json = state.pendingArgs.shift()!;
                yield {
                  type: 'content_block_delta',
                  index: idx,
                  delta: { type: 'input_json_delta', partial_json },
                };
              }
            }
          }

          // Usage (typically only appears at end when include_usage=true)
          if (event?.usage) {
            const inputTokens = event.usage.prompt_tokens ?? 0;
            const outputTokens = event.usage.completion_tokens ?? 0;
            // Agent reads input_tokens + output_tokens from message_delta. We cast because
            // ModelStreamChunk's usage type is intentionally narrower.
            yield {
              type: 'message_delta',
              delta: { type: 'text_delta', text: '' },
              usage: { input_tokens: inputTokens, output_tokens: outputTokens } as any,
            } as any;
          }
        }
      }
    } finally {
      // Close any started blocks so the Agent can finalize buffers.
      if (textBlockIndex !== null) {
        yield { type: 'content_block_stop', index: textBlockIndex };
      }
      for (const [, state] of toolStates) {
        if (state.started && typeof state.startedIndex === 'number') {
          yield { type: 'content_block_stop', index: state.startedIndex };
        }
      }
      yield { type: 'message_stop' };
    }
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

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

type OpenAIChatMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | null; tool_calls?: any[] }
  | { role: 'tool'; tool_call_id: string; content: string };

function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');
}

function toOpenAIChatMessages(messages: Message[], systemPrompt?: string): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    const role = msg.role === 'system' ? 'user' : msg.role;
    const text = blocksToText(msg.content).trim();

    const toolResults = msg.content.filter((b) => b.type === 'tool_result') as Array<any>;
    const toolUses = msg.content.filter((b) => b.type === 'tool_use') as Array<any>;

    if (role === 'assistant' && toolUses.length > 0) {
      const tool_calls = toolUses.map((b) => ({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      }));

      out.push({ role: 'assistant', content: text.length > 0 ? text : null, tool_calls });
    } else if (text.length > 0) {
      out.push({ role: role as any, content: text });
    }

    if (toolResults.length > 0) {
      for (const b of toolResults) {
        const contentStr = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: contentStr });
      }
    }
  }

  return out;
}

function toOpenAITools(tools: any[] | undefined): any[] {
  if (!tools || tools.length === 0) return [];
  return tools
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));
}

function openAIMessageToContentBlocks(msg: any): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (typeof msg?.content === 'string' && msg.content.length > 0) {
    blocks.push({ type: 'text', text: msg.content });
  }

  const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
  for (const call of toolCalls) {
    const id = typeof call?.id === 'string' ? call.id : `toolu_${Date.now()}`;
    const name = call?.function?.name;
    const rawArgs = call?.function?.arguments;
    let input: any = {};
    if (typeof rawArgs === 'string' && rawArgs.length > 0) {
      try {
        input = JSON.parse(rawArgs);
      } catch {
        input = { _raw: rawArgs };
      }
    }

    if (typeof name === 'string' && name.length > 0) {
      blocks.push({ type: 'tool_use', id, name, input });
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }

  return blocks;
}
