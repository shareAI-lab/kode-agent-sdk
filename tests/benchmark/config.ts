import type { ProviderId } from '../helpers/provider-env';
import { loadProviderEnv } from '../helpers/provider-env';
import type { BenchmarkCliArgs, BenchmarkConfig, BenchmarkProvider } from './types';

const ALL_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini', 'glm', 'minimax'];

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

export function parseCliArgs(argv: string[] = process.argv.slice(2)): BenchmarkCliArgs {
  const args: BenchmarkCliArgs = {
    sweOnly: false,
    tauOnly: false,
  };

  for (const arg of argv) {
    if (arg === '--swe-only') {
      args.sweOnly = true;
    } else if (arg === '--tau-only') {
      args.tauOnly = true;
    } else if (arg.startsWith('--swe-mode=')) {
      const val = arg.slice('--swe-mode='.length);
      if (val === 'mini' || val === 'full') args.sweMode = val;
    } else if (arg.startsWith('--tau-domain=')) {
      args.tauDomain = arg.slice('--tau-domain='.length);
    } else if (arg.startsWith('--provider=')) {
      args.provider = arg.slice('--provider='.length);
    } else if (arg.startsWith('--num-trials=')) {
      const n = parseInt(arg.slice('--num-trials='.length), 10);
      if (!isNaN(n) && n > 0) args.numTrials = n;
    } else if (arg.startsWith('--output=')) {
      const val = arg.slice('--output='.length);
      if (val === 'table' || val === 'json' || val === 'html' || val === 'both') args.output = val;
    } else if (arg.startsWith('--output-file=')) {
      args.outputFile = arg.slice('--output-file='.length);
    } else if (arg.startsWith('--compare=')) {
      args.compare = arg.slice('--compare='.length);
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function discoverProviders(filterProvider?: string): BenchmarkProvider[] {
  const envList = process.env.BENCHMARK_PROVIDERS;
  let ids: ProviderId[];

  if (filterProvider) {
    ids = filterProvider.split(',').map(s => s.trim()) as ProviderId[];
  } else if (envList) {
    ids = envList.split(',').map(s => s.trim()) as ProviderId[];
  } else {
    ids = ALL_PROVIDERS;
  }

  const providers: BenchmarkProvider[] = [];

  for (const id of ids) {
    const result = loadProviderEnv(id);
    if (!result.ok || !result.config) continue;
    const { apiKey, model, baseUrl, proxyUrl } = result.config;
    if (!apiKey || !model) continue;
    providers.push({ id, model, apiKey, baseUrl, proxyUrl });
  }

  return providers;
}

function findUserSimProvider(): BenchmarkProvider | undefined {
  const userModel = process.env.BENCHMARK_USER_MODEL;
  if (!userModel) return undefined;

  // Format: provider/model  e.g. "anthropic/claude-opus-4-5-20251101"
  const slashIdx = userModel.indexOf('/');
  if (slashIdx === -1) return undefined;

  const providerId = userModel.slice(0, slashIdx) as ProviderId;
  const model = userModel.slice(slashIdx + 1);

  const result = loadProviderEnv(providerId);
  if (!result.ok || !result.config) return undefined;
  if (!result.config.apiKey) return undefined;

  return {
    id: providerId,
    model,
    apiKey: result.config.apiKey,
    baseUrl: result.config.baseUrl,
    proxyUrl: result.config.proxyUrl,
  };
}

function readSdkVersion(): string {
  try {
    const pkg = require('../../package.json');
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function loadConfig(cliArgs: BenchmarkCliArgs): BenchmarkConfig {
  const envTimeout = process.env.BENCHMARK_TIMEOUT_MS;
  const envTrials = process.env.BENCHMARK_NUM_TRIALS;
  const envOutput = process.env.BENCHMARK_OUTPUT;

  const timeoutMs = envTimeout ? parseInt(envTimeout, 10) : 120_000;
  const numTrials = cliArgs.numTrials
    ?? (envTrials ? parseInt(envTrials, 10) : 1);
  const output = cliArgs.output
    ?? (envOutput === 'json' || envOutput === 'both' || envOutput === 'table' || envOutput === 'html' ? envOutput : 'table');
  const outputFile = cliArgs.outputFile ?? 'benchmark-report.json';
  const sweMode = cliArgs.sweMode ?? 'mini';
  const tauDomain = cliArgs.tauDomain ?? 'all';

  return {
    providers: discoverProviders(cliArgs.provider),
    userSimProvider: findUserSimProvider(),
    timeoutMs,
    numTrials,
    output,
    outputFile,
    sweMode,
    tauDomain,
    sdkVersion: readSdkVersion(),
    dockerProxy: process.env.BENCHMARK_DOCKER_PROXY || undefined,
  };
}
