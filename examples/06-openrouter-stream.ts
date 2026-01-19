import './shared/load-env';

import { OpenRouterProvider, Message, ModelStreamChunk } from '../src';

function chunkToDebugString(chunk: ModelStreamChunk): string {
  if (chunk.type === 'content_block_start') {
    const t = (chunk.content_block as any)?.type;
    if (t === 'tool_use') {
      return `\n[tool_use:start] ${(chunk.content_block as any).name} id=${(chunk.content_block as any).id}\n`;
    }
    if (t === 'text') {
      return `\n[text:start]\n`;
    }
  }

  if (chunk.type === 'content_block_delta') {
    if (chunk.delta?.type === 'text_delta') {
      return chunk.delta.text ?? '';
    }
    if (chunk.delta?.type === 'input_json_delta') {
      return chunk.delta.partial_json ? `[tool_args_delta] ${chunk.delta.partial_json}` : '';
    }
  }

  if (chunk.type === 'content_block_stop') {
    return `\n[block:stop]\n`;
  }

  if (chunk.type === 'message_stop') {
    return `\n[message:stop]\n`;
  }

  return '';
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const modelId = process.env.OPENROUTER_MODEL_ID;
  const baseUrl = process.env.OPENROUTER_BASE_URL;

  if (!apiKey) throw new Error('Missing OPENROUTER_API_KEY');
  if (!modelId) throw new Error('Missing OPENROUTER_MODEL_ID (e.g. openai/gpt-4.1-mini)');

  const provider = new OpenRouterProvider(apiKey, modelId, baseUrl);

  const messages: Message[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Explain what a streaming response is in 5 lines or less, and give a brief example.',
        },
      ],
    },
  ];

  const stream = provider.stream(messages, {
    system: 'You are a helpful engineer. Keep answers short.',
    maxTokens: 300,
    temperature: 0.2,
  });

  for await (const chunk of stream) {
    const s = chunkToDebugString(chunk);
    if (s) process.stdout.write(s);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
