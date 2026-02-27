import type { ProviderId } from '../helpers/provider-env';
import { loadProviderEnv } from '../helpers/provider-env';
import type { BenchmarkCliArgs, BenchmarkConfig, BenchmarkProvider } from './types';

const ALL_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini', 'glm', 'minimax'];

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

export function parseCliArgs(argv: string[] = process.argv.slice(2)): BenchmarkCliArgs {
  const args: BenchmarkCliArgs = {};

  for (const arg of argv) {
    if (arg === '--swe-only') {
      args.benchmark = 'swe';
    } else if (arg === '--tau-only') {
      args.benchmark = 'tau';
    } else if (arg === '--tb2-only') {
      args.benchmark = 'tb2';
    } else if (arg.startsWith('--benchmark=')) {
      const val = arg.slice('--benchmark='.length);
      if (val === 'swe' || val === 'tau' || val === 'tb2' || val === 'both' || val === 'all') args.benchmark = val;
    } else if (arg.startsWith('--provider=')) {
      const v = arg.slice('--provider='.length).trim();
      if (v) args.provider = v;
    } else if (arg.startsWith('--tau-domain=')) {
      const v = arg.slice('--tau-domain='.length).trim();
      if (v) args.tauDomain = v;
    } else if (arg.startsWith('--num-trials=')) {
      const n = parseInt(arg.slice('--num-trials='.length), 10);
      if (!Number.isNaN(n) && n > 0) args.numTrials = n;
    } else if (arg.startsWith('--tb2-model=')) {
      const v = arg.slice('--tb2-model='.length).trim();
      if (v) args.tb2Model = v;
    } else if (arg.startsWith('--model=')) {
      // Backward-compatible alias for TB2 model.
      const v = arg.slice('--model='.length).trim();
      if (v) args.tb2Model = v;
    } else if (arg.startsWith('--tb2-agent=')) {
      const v = arg.slice('--tb2-agent='.length).trim();
      if (v) args.tb2Agent = v;
    } else if (arg.startsWith('--tb2-dataset=')) {
      const v = arg.slice('--tb2-dataset='.length).trim();
      if (v) args.tb2Dataset = v;
    } else if (arg.startsWith('--tb2-runner=')) {
      const val = arg.slice('--tb2-runner='.length);
      if (val === 'auto' || val === 'harbor' || val === 'uvx' || val === 'docker') args.tb2Runner = val;
    } else if (arg.startsWith('--tb2-python=')) {
      const v = arg.slice('--tb2-python='.length).trim();
      if (v) args.tb2Python = v;
    } else if (arg.startsWith('--tb2-jobs-dir=')) {
      const v = arg.slice('--tb2-jobs-dir='.length).trim();
      if (v) args.tb2JobsDir = v;
    } else if (arg.startsWith('--tb2-env-file=')) {
      const v = arg.slice('--tb2-env-file='.length).trim();
      if (v) args.tb2EnvFile = v;
    } else if (arg.startsWith('--tb2-docker-image=')) {
      const v = arg.slice('--tb2-docker-image='.length).trim();
      if (v) args.tb2DockerImage = v;
    } else if (arg.startsWith('--output=')) {
      const val = arg.slice('--output='.length);
      if (val === 'table' || val === 'json') args.output = val;
    } else if (arg.startsWith('--output-file=')) {
      const v = arg.slice('--output-file='.length).trim();
      if (v) args.outputFile = v;
    } else if (arg.startsWith('--compare=')) {
      const v = arg.slice('--compare='.length).trim();
      if (v) args.compare = v;
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

  const slashIdx = userModel.indexOf('/');
  if (slashIdx === -1) return undefined;

  const providerId = userModel.slice(0, slashIdx) as ProviderId;
  const model = userModel.slice(slashIdx + 1);

  const result = loadProviderEnv(providerId);
  if (!result.ok || !result.config || !result.config.apiKey) return undefined;

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
  const envTb2Model = process.env.BENCHMARK_TB2_MODEL
    || (process.env.OPENAI_MODEL_ID ? `openai/${process.env.OPENAI_MODEL_ID}` : undefined);

  const timeoutMs = envTimeout ? parseInt(envTimeout, 10) : 120_000;
  const envTrialsParsed = envTrials ? parseInt(envTrials, 10) : undefined;
  const numTrials = cliArgs.numTrials ?? (envTrialsParsed && envTrialsParsed > 0 ? envTrialsParsed : 1);
  const output = cliArgs.output
    ?? (envOutput === 'json' || envOutput === 'table' ? envOutput : 'table');
  const outputFile = cliArgs.outputFile ?? 'benchmark-report.json';
  const benchmark = cliArgs.benchmark ?? 'both';
  const tauDomain = cliArgs.tauDomain ?? 'airline';
  const tb2Agent = cliArgs.tb2Agent ?? 'oracle';
  const tb2Dataset = cliArgs.tb2Dataset ?? 'terminal-bench@2.0';
  const tb2Runner = cliArgs.tb2Runner ?? 'auto';
  const tb2Python = cliArgs.tb2Python ?? '3.12';
  const tb2JobsDir = cliArgs.tb2JobsDir ?? 'tests/tmp/jobs';
  const tb2EnvFile = cliArgs.tb2EnvFile;
  const tb2DockerImage = cliArgs.tb2DockerImage ?? 'ghcr.io/astral-sh/uv:python3.12-bookworm';

  return {
    benchmark,
    providers: discoverProviders(cliArgs.provider),
    userSimProvider: findUserSimProvider(),
    timeoutMs,
    numTrials,
    tauDomain,
    output,
    outputFile,
    tb2Model: cliArgs.tb2Model ?? envTb2Model,
    tb2Agent,
    tb2Dataset,
    tb2Runner,
    tb2Python,
    tb2JobsDir,
    tb2EnvFile,
    tb2DockerImage,
    sdkVersion: readSdkVersion(),
    dockerProxy: process.env.BENCHMARK_DOCKER_PROXY || undefined,
  };
}
