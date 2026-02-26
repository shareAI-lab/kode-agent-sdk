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
    if (arg.startsWith('--benchmark=')) {
      const val = arg.slice('--benchmark='.length);
      if (val === 'swe' || val === 'tb2' || val === 'both') args.benchmark = val;
    } else if (arg.startsWith('--provider=')) {
      args.provider = arg.slice('--provider='.length);
    } else if (arg.startsWith('--tb2-model=')) {
      args.tb2Model = arg.slice('--tb2-model='.length);
    } else if (arg.startsWith('--model=')) {
      // Backward-compatible alias for TB2 model.
      args.tb2Model = arg.slice('--model='.length);
    } else if (arg.startsWith('--tb2-agent=')) {
      args.tb2Agent = arg.slice('--tb2-agent='.length);
    } else if (arg.startsWith('--tb2-dataset=')) {
      args.tb2Dataset = arg.slice('--tb2-dataset='.length);
    } else if (arg.startsWith('--tb2-runner=')) {
      const val = arg.slice('--tb2-runner='.length);
      if (val === 'auto' || val === 'harbor' || val === 'uvx' || val === 'docker') args.tb2Runner = val;
    } else if (arg.startsWith('--tb2-python=')) {
      args.tb2Python = arg.slice('--tb2-python='.length);
    } else if (arg.startsWith('--tb2-jobs-dir=')) {
      args.tb2JobsDir = arg.slice('--tb2-jobs-dir='.length);
    } else if (arg.startsWith('--tb2-env-file=')) {
      args.tb2EnvFile = arg.slice('--tb2-env-file='.length);
    } else if (arg.startsWith('--tb2-docker-image=')) {
      args.tb2DockerImage = arg.slice('--tb2-docker-image='.length);
    } else if (arg.startsWith('--output=')) {
      const val = arg.slice('--output='.length);
      if (val === 'table' || val === 'json') args.output = val;
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
  const envOutput = process.env.BENCHMARK_OUTPUT;
  const envTb2Model = process.env.BENCHMARK_TB2_MODEL
    || (process.env.OPENAI_MODEL_ID ? `openai/${process.env.OPENAI_MODEL_ID}` : undefined);

  const timeoutMs = envTimeout ? parseInt(envTimeout, 10) : 120_000;
  const output = cliArgs.output
    ?? (envOutput === 'json' || envOutput === 'table' ? envOutput : 'table');
  const outputFile = cliArgs.outputFile ?? 'benchmark-report.json';
  const benchmark = cliArgs.benchmark ?? 'both';
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
    timeoutMs,
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
