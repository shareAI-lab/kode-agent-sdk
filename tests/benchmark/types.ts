import type { ProviderId } from '../helpers/provider-env';

export interface BenchmarkProvider {
  id: ProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
}

export interface BenchmarkCliArgs {
  benchmark?: 'swe' | 'tb2' | 'both';
  provider?: string;
  tb2Model?: string;
  tb2Agent?: string;
  tb2Dataset?: string;
  tb2Runner?: 'auto' | 'harbor' | 'uvx' | 'docker';
  tb2Python?: string;
  tb2JobsDir?: string;
  tb2EnvFile?: string;
  tb2DockerImage?: string;
  output?: 'table' | 'json';
  outputFile?: string;
  compare?: string;
}

export interface BenchmarkConfig {
  benchmark: 'swe' | 'tb2' | 'both';
  providers: BenchmarkProvider[];
  timeoutMs: number;
  output: 'table' | 'json';
  outputFile: string;
  tb2Model?: string;
  tb2Agent: string;
  tb2Dataset: string;
  tb2Runner: 'auto' | 'harbor' | 'uvx' | 'docker';
  tb2Python: string;
  tb2JobsDir: string;
  tb2EnvFile?: string;
  tb2DockerImage: string;
  sdkVersion: string;
  dockerProxy?: string;
}

export interface SWEResult {
  instance_id: string;
  resolved: boolean;
  tokens_used: number;
  duration_ms: number;
  error?: string;
}

export interface SWESummary {
  dataset: string;
  total: number;
  resolved: number;
  rate: number;
  avg_tokens: number;
  avg_duration_ms: number;
}

export interface SWEProviderResult {
  provider: BenchmarkProvider;
  summary: SWESummary;
  results: SWEResult[];
}

export interface TB2Summary {
  generated_at: string;
  dataset: string;
  agent: string;
  model?: string;
  jobs_dir: string;
  job_path: string;
  passed: number;
  total: number;
  rate: number;
  unknown: number;
}

export interface BenchmarkReport {
  timestamp: string;
  sdk_version: string;
  swe?: SWEProviderResult[];
  tb2?: TB2Summary;
}

export interface BenchmarkModuleResult {
  swe?: SWEProviderResult[];
  tb2?: TB2Summary;
}
