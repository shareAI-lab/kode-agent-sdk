import type { ProviderId } from '../helpers/provider-env';

export interface BenchmarkProvider {
  id: ProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
}

export interface BenchmarkCliArgs {
  benchmark?: 'swe' | 'tau' | 'tb2' | 'both' | 'all';
  provider?: string;
  tauDomain?: 'airline' | 'retail' | 'telecom' | 'all' | string;
  numTrials?: number;
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
  benchmark: 'swe' | 'tau' | 'tb2' | 'both' | 'all';
  providers: BenchmarkProvider[];
  userSimProvider?: BenchmarkProvider;
  timeoutMs: number;
  numTrials: number;
  tauDomain: string;
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

export interface TAUTaskResult {
  task_id: string;
  trial_pass_rates: boolean[];
  tokens_used: number;
  error?: string;
}

export interface TAUSummary {
  domain: string;
  total_tasks: number;
  num_trials: number;
  pass_at_k: number[];
  avg_tokens: number;
  token_observed_trials?: number;
}

export interface TAUProviderResult {
  provider: BenchmarkProvider;
  summary: TAUSummary;
  results: TAUTaskResult[];
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
  avg_input_tokens?: number;
  avg_output_tokens?: number;
  avg_cache_tokens?: number;
  avg_total_tokens?: number;
  token_observed_trials?: number;
}

export interface BenchmarkReport {
  timestamp: string;
  sdk_version: string;
  swe?: SWEProviderResult[];
  tau?: TAUProviderResult[];
  tb2?: TB2Summary;
}

export interface BenchmarkModuleResult {
  swe?: SWEProviderResult[];
  tau?: TAUProviderResult[];
  tb2?: TB2Summary;
}
