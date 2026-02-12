import type { ProviderId } from '../helpers/provider-env';

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface BenchmarkProvider {
  id: ProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string;
  proxyUrl?: string;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export interface BenchmarkCliArgs {
  sweOnly: boolean;
  tauOnly: boolean;
  sweMode?: 'mini' | 'full';
  tauDomain?: string;
  provider?: string;
  numTrials?: number;
  output?: 'table' | 'json' | 'html' | 'both';
  outputFile?: string;
  compare?: string;
}

// ---------------------------------------------------------------------------
// Config (merged env + CLI)
// ---------------------------------------------------------------------------

export interface BenchmarkConfig {
  providers: BenchmarkProvider[];
  userSimProvider?: BenchmarkProvider;
  timeoutMs: number;
  numTrials: number;
  output: 'table' | 'json' | 'html' | 'both';
  outputFile: string;
  sweMode: 'mini' | 'full';
  tauDomain: string;
  sdkVersion: string;
  dockerProxy?: string;
}

// ---------------------------------------------------------------------------
// SWE-bench types
// ---------------------------------------------------------------------------

export interface SWEInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  patch: string;
  test_patch: string;
  problem_statement: string;
  hints_text: string;
  created_at: string;
  version: string;
}

export interface MiniSWECase {
  id: string;
  repo: string;
  description: string;
  files: Record<string, string>;
  expected_patch: string;
  test_command: string;
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

// ---------------------------------------------------------------------------
// TAU-bench types
// ---------------------------------------------------------------------------

export interface TAUTask {
  task_id: string;
  domain: string;
  user_instruction: string;
  expected_actions: string[];
  tools: string[];
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
}

export interface TAUProviderResult {
  provider: BenchmarkProvider;
  summary: TAUSummary;
  results: TAUTaskResult[];
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

export interface BenchmarkReport {
  timestamp: string;
  sdk_version: string;
  swe?: SWEProviderResult[];
  tau?: TAUProviderResult[];
}

// ---------------------------------------------------------------------------
// Module contract (Phase 2+ modules implement this)
// ---------------------------------------------------------------------------

export interface BenchmarkModuleResult {
  swe?: SWEProviderResult[];
  tau?: TAUProviderResult[];
}

export interface BenchmarkModule {
  name: string;
  run(config: BenchmarkConfig): Promise<BenchmarkModuleResult>;
}
