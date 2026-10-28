import { AnthropicProvider, ModelConfig, ModelProvider } from '@shareai-lab/kode-sdk';

export function createDemoModelProvider(config: ModelConfig): ModelProvider {
  const apiKey =
    config.apiKey ??
    process.env.ANTHROPIC_API_KEY ??
    process.env.ANTHROPIC_API_TOKEN ??
    process.env.ANTHROPIC_API_Token;
  if (!apiKey) {
    throw new Error('Anthropic API key/token is required. Set ANTHROPIC_API_KEY or ANTHROPIC_API_TOKEN.');
  }

  const baseUrl = config.baseUrl ?? process.env.ANTHROPIC_BASE_URL;
  const modelId = config.model ?? process.env.ANTHROPIC_MODEL_ID ?? 'claude-sonnet-4-5-20250929';

  return new AnthropicProvider(apiKey, modelId, baseUrl);
}
