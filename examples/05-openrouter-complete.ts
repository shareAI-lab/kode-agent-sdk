import './shared/load-env';

import { OpenRouterProvider, Message } from '../src';

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const modelId = process.env.OPENROUTER_MODEL_ID;
  const baseUrl = process.env.OPENROUTER_BASE_URL;

  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY');
  }
  if (!modelId) {
    throw new Error('Missing OPENROUTER_MODEL_ID (e.g. openai/gpt-4.1-mini, anthropic/claude-3.5-sonnet)');
  }

  const provider = new OpenRouterProvider(apiKey, modelId, baseUrl);

  const messages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Hello! Summarize the core benefits of "event-driven agent runtime" in three sentences.' }],
    },
  ];

  const resp = await provider.complete(messages, {
    system: 'You are a helpful engineer. Keep answers short.',
    maxTokens: 400,
    temperature: 0.2,
  });

  const text = resp.content
    .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
    .join('');

  console.log(text);
  if (resp.usage) {
    console.log(`\n--- usage: in=${resp.usage.input_tokens} out=${resp.usage.output_tokens} ---`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
