import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import type {
  BenchmarkConfig,
  BenchmarkModuleResult,
  BenchmarkProvider,
  TAUProviderResult,
  TAUTaskResult,
} from '../types';

export const name = 'tau';

const TAU2_SOURCE = 'git+https://github.com/sierra-research/tau2-bench@v0.2.0';
const TAU2_REPO = 'https://github.com/sierra-research/tau2-bench';
const TAU2_REF = 'v0.2.0';
const DEFAULT_TAU2_DATA_DIR = path.resolve(process.cwd(), 'tests/tmp/tau2-data');
const PASS_REWARD = 1;
const PASS_TOL = 1e-6;

interface RunnerSpec {
  cmd: string;
  baseArgs: string[];
  label: string;
}

interface Tau2Task {
  id?: string;
}

interface Tau2RewardInfo {
  reward?: number;
}

interface Tau2Simulation {
  task_id?: string;
  trial?: number;
  reward_info?: Tau2RewardInfo;
  [key: string]: unknown;
}

interface Tau2RunOutput {
  info?: { num_trials?: number };
  tasks?: Tau2Task[];
  simulations?: Tau2Simulation[];
}

function hasCommand(cmd: string, versionArg = '--version'): boolean {
  const r = spawnSync(cmd, [versionArg], { stdio: 'ignore' });
  return r.status === 0;
}

function getDomains(tauDomain: string): string[] {
  if (tauDomain === 'all') return ['airline', 'retail', 'telecom'];
  return [tauDomain];
}

function ensureDataDir(dataDir: string): void {
  fs.mkdirSync(path.join(dataDir, 'simulations'), { recursive: true });
}

function requiredTaskFiles(dataDir: string, domains: string[]): string[] {
  return domains.map(domain => path.join(dataDir, 'tau2', 'domains', domain, 'tasks.json'));
}

function ensureOfficialDataFiles(dataDir: string, domains: string[]): void {
  const missingBefore = requiredTaskFiles(dataDir, domains).filter(p => !fs.existsSync(p));
  if (missingBefore.length === 0) return;

  if (!hasCommand('git')) {
    throw new Error(
      `TAU2 data files missing and git is not available. Missing: ${missingBefore.join(', ')}`,
    );
  }

  const sourceDir = path.join(dataDir, '.tau2-source');
  const sourceDataDir = path.join(sourceDir, 'data', 'tau2');

  console.log('  TAU2 data missing, bootstrapping official data from repository...');
  if (!fs.existsSync(sourceDataDir)) {
    if (fs.existsSync(sourceDir)) {
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
    const clone = spawnSync(
      'git',
      ['clone', '--depth', '1', '--branch', TAU2_REF, TAU2_REPO, sourceDir],
      { stdio: 'inherit' },
    );
    if (clone.status !== 0) {
      throw new Error(`Failed to clone TAU2 data source (exit code ${clone.status ?? 'unknown'})`);
    }
  }

  if (!fs.existsSync(sourceDataDir)) {
    throw new Error(`TAU2 data source missing expected directory: ${sourceDataDir}`);
  }

  fs.mkdirSync(path.join(dataDir, 'tau2'), { recursive: true });
  fs.cpSync(sourceDataDir, path.join(dataDir, 'tau2'), { recursive: true, force: true });

  const missingAfter = requiredTaskFiles(dataDir, domains).filter(p => !fs.existsSync(p));
  if (missingAfter.length > 0) {
    throw new Error(`TAU2 data bootstrap incomplete. Missing: ${missingAfter.join(', ')}`);
  }
}

function shouldKeepTauLogLine(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  if (s.includes('Provider List: https://docs.litellm.ai/docs/providers')) return false;
  if (s.includes('tau2.utils.llm_utils:get_response_cost')) return false;
  if (s.includes("This model isn't mapped yet.")) return false;
  return true;
}

function createLineEmitter(isErr: boolean): (chunk: Buffer | string, flush?: boolean) => void {
  let buffer = '';
  return (chunk: Buffer | string, flush = false) => {
    if (chunk) {
      buffer += chunk.toString().replace(/\r/g, '\n');
    }
    const parts = buffer.split('\n');
    if (!flush) {
      buffer = parts.pop() ?? '';
    } else {
      buffer = '';
    }
    for (const line of parts) {
      if (!shouldKeepTauLogLine(line)) continue;
      if (isErr) console.error(line);
      else console.log(line);
    }
  };
}

async function runTau2WithFilteredLogs(
  runner: RunnerSpec,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const child = spawn(runner.cmd, args, {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const out = createLineEmitter(false);
  const err = createLineEmitter(true);

  child.stdout?.on('data', (chunk: Buffer | string) => out(chunk, false));
  child.stderr?.on('data', (chunk: Buffer | string) => err(chunk, false));

  return await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => {
      out('', true);
      err('', true);
      resolve(code ?? 1);
    });
  });
}

function sanitizeLabel(v: string): string {
  return v.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 96);
}

function toTau2Model(bp: BenchmarkProvider): string {
  if (bp.model.includes('/')) return bp.model;
  if (bp.id === 'anthropic') return `anthropic/${bp.model}`;
  if (bp.id === 'gemini') return `gemini/${bp.model}`;
  return `openai/${bp.model}`;
}

function applyProviderEnv(env: NodeJS.ProcessEnv, bp: BenchmarkProvider): void {
  switch (bp.id) {
    case 'anthropic':
      env.ANTHROPIC_API_KEY = bp.apiKey;
      if (bp.baseUrl) env.ANTHROPIC_BASE_URL = bp.baseUrl;
      break;
    case 'gemini':
      env.GEMINI_API_KEY = bp.apiKey;
      if (bp.baseUrl) env.GEMINI_BASE_URL = bp.baseUrl;
      break;
    default:
      env.OPENAI_API_KEY = bp.apiKey;
      if (bp.baseUrl) {
        env.OPENAI_BASE_URL = bp.baseUrl;
        env.OPENAI_API_BASE = bp.baseUrl;
      }
      break;
  }
}

function buildRunEnv(config: BenchmarkConfig, bp: BenchmarkProvider, userSimBp: BenchmarkProvider, dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TAU2_DATA_DIR: dataDir,
    UV_CACHE_DIR: process.env.UV_CACHE_DIR || '/tmp/uv-cache',
    UV_TOOL_DIR: process.env.UV_TOOL_DIR || '/tmp/uv-tools',
    XDG_DATA_HOME: process.env.XDG_DATA_HOME || '/tmp/xdg-data',
  };
  if (config.dockerProxy) {
    env.HTTP_PROXY = config.dockerProxy;
    env.HTTPS_PROXY = config.dockerProxy;
    env.http_proxy = config.dockerProxy;
    env.https_proxy = config.dockerProxy;
  }
  applyProviderEnv(env, bp);
  applyProviderEnv(env, userSimBp);
  return env;
}

function resolveRunner(): RunnerSpec {
  if (hasCommand('tau2')) {
    return { cmd: 'tau2', baseArgs: [], label: 'tau2' };
  }
  if (hasCommand('uvx')) {
    return {
      cmd: 'uvx',
      baseArgs: ['--python', '3.12', '--from', TAU2_SOURCE, 'tau2'],
      label: `uvx tau2 (${TAU2_SOURCE})`,
    };
  }
  throw new Error('TAU official runner not found. Install `tau2` or `uvx`.');
}

function readJson(filePath: string): Tau2RunOutput {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Tau2RunOutput;
}

function isPass(sim: Tau2Simulation): boolean {
  const reward = sim.reward_info?.reward;
  return typeof reward === 'number' && Math.abs(reward - PASS_REWARD) <= PASS_TOL;
}

function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let kk = Math.min(k, n - k);
  let out = 1;
  for (let i = 1; i <= kk; i++) {
    out = (out * (n - kk + i)) / i;
  }
  return out;
}

function computePassHatK(taskOutcomes: boolean[][]): number[] {
  const eligible = taskOutcomes.filter(arr => arr.length > 0);
  if (eligible.length === 0) return [];

  const maxK = Math.min(...eligible.map(arr => arr.length));
  const passAtK: number[] = [];

  for (let k = 1; k <= maxK; k++) {
    const vals: number[] = [];
    for (const arr of eligible) {
      const n = arr.length;
      if (n < k) continue;
      const c = arr.filter(Boolean).length;
      const denom = combinations(n, k);
      vals.push(denom === 0 ? 0 : combinations(c, k) / denom);
    }
    passAtK.push(vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0);
  }

  return passAtK;
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function getPathNumber(obj: unknown, keys: string[]): number | undefined {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return asFiniteNumber(cur);
}

function findNumberByKeys(obj: unknown, candidates: string[]): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const queue: unknown[] = [obj];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) {
      for (const v of cur) queue.push(v);
      continue;
    }
    for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
      if (candidates.includes(k)) {
        const n = asFiniteNumber(v);
        if (n !== undefined) return n;
      }
      if (v && typeof v === 'object') queue.push(v);
    }
  }
  return undefined;
}

interface TokenUsage {
  input?: number;
  output?: number;
  cache?: number;
  total?: number;
}

function extractTokenUsage(obj: unknown): TokenUsage {
  const input = getPathNumber(obj, ['agent_result', 'n_input_tokens'])
    ?? getPathNumber(obj, ['agent_result', 'usage', 'input_tokens'])
    ?? findNumberByKeys(obj, ['n_input_tokens', 'input_tokens', 'prompt_tokens']);
  const output = getPathNumber(obj, ['agent_result', 'n_output_tokens'])
    ?? getPathNumber(obj, ['agent_result', 'usage', 'output_tokens'])
    ?? findNumberByKeys(obj, ['n_output_tokens', 'output_tokens', 'completion_tokens']);
  const cache = getPathNumber(obj, ['agent_result', 'n_cache_tokens'])
    ?? findNumberByKeys(obj, ['n_cache_tokens', 'cache_tokens']);
  const total = getPathNumber(obj, ['agent_result', 'n_total_tokens'])
    ?? getPathNumber(obj, ['agent_result', 'usage', 'total_tokens'])
    ?? findNumberByKeys(obj, ['n_total_tokens', 'total_tokens']);

  if (total !== undefined) return { input, output, cache, total };
  if (input !== undefined || output !== undefined || cache !== undefined) {
    return {
      input,
      output,
      cache,
      total: (input ?? 0) + (output ?? 0) + (cache ?? 0),
    };
  }
  return {};
}

function parseTau2Output(
  bp: BenchmarkProvider,
  domain: string,
  filePath: string,
  expectedTrials: number,
): TAUProviderResult {
  const parsed = readJson(filePath);
  const taskIds = new Set<string>();
  for (const t of parsed.tasks ?? []) {
    if (typeof t.id === 'string' && t.id.length > 0) taskIds.add(t.id);
  }
  for (const sim of parsed.simulations ?? []) {
    if (typeof sim.task_id === 'string' && sim.task_id.length > 0) taskIds.add(sim.task_id);
  }

  const trialMatrix = new Map<string, boolean[]>();
  const tokenMatrix = new Map<string, Array<number | undefined>>();
  for (const id of taskIds) trialMatrix.set(id, []);
  for (const id of taskIds) tokenMatrix.set(id, []);

  for (const sim of parsed.simulations ?? []) {
    const taskId = sim.task_id;
    if (!taskId || !trialMatrix.has(taskId)) continue;
    const arr = trialMatrix.get(taskId)!;
    const tokenArr = tokenMatrix.get(taskId)!;
    const usage = extractTokenUsage(sim);
    const tokenVal = usage.total;
    if (typeof sim.trial === 'number' && sim.trial >= 0) {
      arr[sim.trial] = isPass(sim);
      tokenArr[sim.trial] = tokenVal;
    } else {
      arr.push(isPass(sim));
      tokenArr.push(tokenVal);
    }
  }

  const results: TAUTaskResult[] = [];
  const outcomes: boolean[][] = [];
  let tokenSum = 0;
  let tokenObservedTrials = 0;
  for (const taskId of taskIds) {
    const normalized = (trialMatrix.get(taskId) ?? []).filter((v): v is boolean => typeof v === 'boolean');
    const tokens = (tokenMatrix.get(taskId) ?? []).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const taskAvgTokens = tokens.length > 0
      ? Math.round(tokens.reduce((s, t) => s + t, 0) / tokens.length)
      : 0;
    tokenSum += tokens.reduce((s, t) => s + t, 0);
    tokenObservedTrials += tokens.length;
    outcomes.push(normalized);
    results.push({
      task_id: taskId,
      trial_pass_rates: normalized,
      tokens_used: taskAvgTokens,
      error: normalized.length === 0 ? 'No trial results in official TAU2 output' : undefined,
    });
  }

  const passAtK = computePassHatK(outcomes);
  const avgTokens = tokenObservedTrials > 0 ? Math.round(tokenSum / tokenObservedTrials) : 0;
  return {
    provider: bp,
    summary: {
      domain,
      total_tasks: taskIds.size,
      num_trials: parsed.info?.num_trials ?? expectedTrials,
      pass_at_k: passAtK,
      avg_tokens: avgTokens,
      token_observed_trials: tokenObservedTrials,
    },
    results,
  };
}

async function runProviderOnDomainOfficial(
  config: BenchmarkConfig,
  runner: RunnerSpec,
  dataDir: string,
  domain: string,
  bp: BenchmarkProvider,
  userSimBp: BenchmarkProvider,
): Promise<TAUProviderResult> {
  const agentLlm = toTau2Model(bp);
  const userLlm = toTau2Model(userSimBp);
  const saveName = sanitizeLabel(
    `tau2-${domain}-${bp.id}-${bp.model}-${Date.now()}`,
  );
  const outputPath = path.join(dataDir, 'simulations', `${saveName}.json`);

  const runArgs = [
    ...runner.baseArgs,
    'run',
    '--domain',
    domain,
    '--agent-llm',
    agentLlm,
    '--user-llm',
    userLlm,
    '--num-trials',
    String(config.numTrials),
    '--save-to',
    saveName,
  ];

  console.log(`    [${bp.id}] ${domain}: tau2 run (${runner.label})`);
  const runStatus = await runTau2WithFilteredLogs(
    runner,
    runArgs,
    buildRunEnv(config, bp, userSimBp, dataDir),
  );

  if (runStatus !== 0) {
    throw new Error(`tau2 run failed with exit code ${runStatus}`);
  }
  if (!fs.existsSync(outputPath)) {
    throw new Error(`tau2 output not found: ${outputPath}`);
  }

  return parseTau2Output(bp, domain, outputPath, config.numTrials);
}

export async function run(config: BenchmarkConfig): Promise<BenchmarkModuleResult> {
  const domains = getDomains(config.tauDomain);
  if (domains.length === 0) {
    console.log(`  TAU: no domains found for "${config.tauDomain}"`);
    return {};
  }
  if (config.providers.length === 0) {
    console.log('  TAU: no providers configured, skipping');
    return {};
  }

  const runner = resolveRunner();
  const dataDir = DEFAULT_TAU2_DATA_DIR;
  ensureDataDir(dataDir);
  ensureOfficialDataFiles(dataDir, domains);
  console.log(`\n  TAU official source: tau2 (${TAU2_SOURCE})`);
  console.log(`  TAU data dir: ${dataDir}`);

  const allResults: TAUProviderResult[] = [];
  for (const domain of domains) {
    console.log(`\n  TAU domain: ${domain} (${config.numTrials} trials)`);
    for (const bp of config.providers) {
      const userSimBp = config.userSimProvider ?? bp;
      console.log(`\n  Running provider: ${bp.id} / ${bp.model}`);
      console.log(`  User simulator:   ${userSimBp.id} / ${userSimBp.model}`);
      try {
        const r = await runProviderOnDomainOfficial(config, runner, dataDir, domain, bp, userSimBp);
        allResults.push(r);
      } catch (err: any) {
        console.log(`    [${bp.id}] ${domain}: FAIL (${err?.message || String(err)})`);
        allResults.push({
          provider: bp,
          summary: {
            domain,
            total_tasks: 0,
            num_trials: config.numTrials,
            pass_at_k: [],
            avg_tokens: 0,
            token_observed_trials: 0,
          },
          results: [],
        });
      }
    }
  }

  return { tau: allResults };
}
