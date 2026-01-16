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
    input_tokens?: number;
    output_tokens: number;
  };
}

export interface ModelConfig {
  provider: 'anthropic' | string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  proxyUrl?: string;
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
  private readonly dispatcher?: any;

  constructor(
    private apiKey: string,
    model: string = 'claude-3-5-sonnet-20241022',
    private baseUrl: string = 'https://api.anthropic.com',
    proxyUrl?: string
  ) {
    this.model = model;
    this.baseUrl = normalizeAnthropicBaseUrl(baseUrl);
    this.dispatcher = getProxyDispatcher(proxyUrl);
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

    const response = await fetch(
      `${this.baseUrl}/v1/messages`,
      withProxy(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
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

    const response = await fetch(
      `${this.baseUrl}/v1/messages`,
      withProxy(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
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
      content: msg.content.map((block) => {
        if (block.type !== 'tool_result') return block;
        return {
          ...block,
          content: formatToolResult(block.content),
        };
      }),
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

export class OpenAIProvider implements ModelProvider {
  readonly maxWindowSize = 128_000;
  readonly maxOutputTokens = 4096;
  readonly temperature = 0.7;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly dispatcher?: any;

  constructor(
    private apiKey: string,
    model: string = 'gpt-4o',
    baseUrl: string = 'https://api.openai.com/v1',
    proxyUrl?: string
  ) {
    this.model = model;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.dispatcher = getProxyDispatcher(proxyUrl);
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
      messages: buildOpenAIMessages(messages, opts?.system),
    };

    if (opts?.tools && opts.tools.length > 0) {
      body.tools = buildOpenAITools(opts.tools);
    }
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const response = await fetch(
      `${this.baseUrl}/chat/completions`,
      withProxy(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
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

    return {
      role: 'assistant',
      content: contentBlocks,
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
    }
  ): AsyncIterable<ModelStreamChunk> {
    const body: any = {
      model: this.model,
      messages: buildOpenAIMessages(messages, opts?.system),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (opts?.tools && opts.tools.length > 0) {
      body.tools = buildOpenAITools(opts.tools);
    }
    if (opts?.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const response = await fetch(
      `${this.baseUrl}/chat/completions`,
      withProxy(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
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
      provider: 'openai',
      model: this.model,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      maxTokens: this.maxOutputTokens,
      temperature: this.temperature,
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

  constructor(
    private apiKey: string,
    model: string = 'gemini-3.0-flash',
    baseUrl: string = 'https://generativelanguage.googleapis.com/v1beta',
    proxyUrl?: string
  ) {
    this.model = model;
    this.baseUrl = normalizeGeminiBaseUrl(baseUrl);
    this.dispatcher = getProxyDispatcher(proxyUrl);
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
    const body: any = buildGeminiRequestBody(messages, {
      system: opts?.system,
      tools: opts?.tools,
      maxTokens: opts?.maxTokens ?? this.maxOutputTokens,
      temperature: opts?.temperature ?? this.temperature,
    });

    const url = buildGeminiUrl(this.baseUrl, this.model, 'generateContent', this.apiKey);
    const response = await fetch(
      url.toString(),
      withProxy(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
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
    const contentBlocks = extractGeminiContentBlocks(candidate?.content);
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
    }
  ): AsyncIterable<ModelStreamChunk> {
    const body: any = buildGeminiRequestBody(messages, {
      system: opts?.system,
      tools: opts?.tools,
      maxTokens: opts?.maxTokens ?? this.maxOutputTokens,
      temperature: opts?.temperature ?? this.temperature,
    });

    const url = buildGeminiUrl(this.baseUrl, this.model, 'streamGenerateContent', this.apiKey);
    const response = await fetch(
      url.toString(),
      withProxy(
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
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

function buildOpenAIMessages(messages: Message[], system?: string): any[] {
  const output: any[] = [];
  const toolCallNames = new Map<string, string>();

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolCallNames.set(block.id, block.name);
      }
    }
  }

  if (system) {
    output.push({ role: 'system', content: system });
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = joinTextBlocks(msg.content);
      if (text) {
        output.push({ role: 'system', content: text });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const text = joinTextBlocks(msg.content);
      const toolCalls = msg.content.filter((block) => block.type === 'tool_use') as Array<{
        id: string;
        name: string;
        input: any;
      }>;

      const entry: any = { role: 'assistant' };
      if (text) {
        entry.content = text;
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

      if (entry.content !== undefined || entry.tool_calls) {
        output.push(entry);
      }
      continue;
    }

    if (msg.role === 'user') {
      let textBuffer = '';
      const flushText = () => {
        if (!textBuffer) return;
        output.push({ role: 'user', content: textBuffer });
        textBuffer = '';
      };

      for (const block of msg.content) {
        if (block.type === 'text') {
          textBuffer += block.text;
          continue;
        }
        if (block.type === 'tool_result') {
          flushText();
          const toolMessage: any = {
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: formatToolResult(block.content),
          };
          const name = toolCallNames.get(block.tool_use_id) ?? 'tool';
          toolMessage.name = name;
          output.push(toolMessage);
        }
      }
      flushText();
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
  }
): any {
  const systemInstruction = buildGeminiSystemInstruction(messages, opts.system);
  const contents = buildGeminiContents(messages);
  const tools = opts.tools && opts.tools.length > 0 ? buildGeminiTools(opts.tools) : undefined;

  const generationConfig: any = {};
  if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) generationConfig.maxOutputTokens = opts.maxTokens;

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

function buildGeminiSystemInstruction(messages: Message[], system?: string): string | undefined {
  const parts: string[] = [];
  if (system) parts.push(system);
  for (const msg of messages) {
    if (msg.role !== 'system') continue;
    const text = joinTextBlocks(msg.content);
    if (text) parts.push(text);
  }
  if (parts.length === 0) return undefined;
  return parts.join('\n\n---\n\n');
}

function buildGeminiContents(messages: Message[]): any[] {
  const contents: any[] = [];
  const toolNameById = new Map<string, string>();
  const toolSignatureById = new Map<string, string>();

  for (const msg of messages) {
    for (const block of msg.content) {
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
    for (const block of msg.content) {
      if (block.type === 'text') {
        if (block.text) parts.push({ text: block.text });
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
