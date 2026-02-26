/**
 * Run Terminal Bench 2.0 using the official Harbor harness, then print score.
 *
 * Primary command (from official docs style):
 *   harbor run -d terminal-bench@2.0 -m <model> -a <agent>
 *
 * This wrapper:
 * - invokes Harbor
 * - locates the latest job directory under ./jobs
 * - computes pass rate from trial result.json / verifier reward
 */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { TB2Summary } from './types';

interface CliArgs {
  dataset: string;
  model?: string;
  agent: string;
  jobsDir: string;
  runner: 'auto' | 'harbor' | 'uvx' | 'docker';
  dockerImage: string;
  python: string;
  envFile?: string;
  outputFile?: string;
}

function parseCliArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  const args: CliArgs = {
    dataset: 'terminal-bench@2.0',
    agent: 'oracle',
    jobsDir: path.resolve(process.cwd(), 'tests/tmp/jobs'),
    runner: 'auto',
    dockerImage: 'ghcr.io/astral-sh/uv:python3.12-bookworm',
    python: '3.12',
  };

  for (const arg of argv) {
    if (arg.startsWith('--dataset=')) {
      args.dataset = arg.slice('--dataset='.length);
    } else if (arg.startsWith('--model=')) {
      args.model = arg.slice('--model='.length);
    } else if (arg.startsWith('--agent=')) {
      args.agent = arg.slice('--agent='.length);
    } else if (arg.startsWith('--jobs-dir=')) {
      args.jobsDir = path.resolve(arg.slice('--jobs-dir='.length));
    } else if (arg.startsWith('--runner=')) {
      const v = arg.slice('--runner='.length);
      if (v === 'auto' || v === 'harbor' || v === 'uvx' || v === 'docker') args.runner = v;
    } else if (arg.startsWith('--docker-image=')) {
      args.dockerImage = arg.slice('--docker-image='.length);
    } else if (arg.startsWith('--python=')) {
      args.python = arg.slice('--python='.length);
    } else if (arg.startsWith('--env-file=')) {
      args.envFile = path.resolve(arg.slice('--env-file='.length));
    } else if (arg.startsWith('--output-file=')) {
      args.outputFile = arg.slice('--output-file='.length);
    }
  }

  const defaultEnvFile = path.resolve(process.cwd(), '.env.test');
  if (!args.envFile && fs.existsSync(defaultEnvFile)) {
    args.envFile = defaultEnvFile;
  }

  return args;
}

function hasCommand(cmd: string, versionArg = '--version'): boolean {
  const r = spawnSync(cmd, [versionArg], { stdio: 'ignore' });
  return r.status === 0;
}

function readEnvFileValue(envFile: string, key: string): string | undefined {
  if (!fs.existsSync(envFile)) return undefined;
  try {
    const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const k = line.slice(0, idx).trim();
      if (k !== key) continue;
      let v = line.slice(idx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      return v;
    }
  } catch {
    // ignore parse failure and fallback to process.env
  }
  return undefined;
}

function proxyLooksLocalhost(proxyUrl?: string): boolean {
  if (!proxyUrl) return false;
  try {
    const u = new URL(proxyUrl);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch {
    return proxyUrl.includes('127.0.0.1') || proxyUrl.includes('localhost');
  }
}

interface RunnerSpec {
  cmd: string;
  baseArgs: string[];
  label: string;
  env?: NodeJS.ProcessEnv;
}

function resolveProxy(args: CliArgs): string | undefined {
  return process.env.BENCHMARK_DOCKER_PROXY
    || (args.envFile ? readEnvFileValue(args.envFile, 'BENCHMARK_DOCKER_PROXY') : undefined);
}

function buildDockerRunner(args: CliArgs, cwdForRun: string): RunnerSpec {
  if (!hasCommand('docker')) {
    throw new Error('docker not found, cannot use --runner=docker');
  }

  const cacheHostDir = path.resolve(path.dirname(args.jobsDir), '.tb2-uv-cache');
  fs.mkdirSync(cacheHostDir, { recursive: true });

  const baseArgs = [
    'run',
    '--rm',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${cwdForRun}:${cwdForRun}`,
    '-v',
    `${cacheHostDir}:/tmp/uv-cache`,
    '-w',
    cwdForRun,
    '-e',
    'UV_CACHE_DIR=/tmp/uv-cache',
  ];

  if (args.envFile && fs.existsSync(args.envFile)) {
    baseArgs.push('--env-file', args.envFile);
  }

  // Reuse BENCHMARK_DOCKER_PROXY as fallback proxy for Harbor/uvx downloads.
  const fallbackProxy = resolveProxy(args);
  const isLinux = process.platform === 'linux';
  let usedHostNetwork = false;
  if (isLinux && proxyLooksLocalhost(fallbackProxy)) {
    // On Linux, localhost proxy on host is only reachable from container via host network.
    baseArgs.push('--network', 'host');
    usedHostNetwork = true;
  }
  if (fallbackProxy) {
    baseArgs.push(
      '-e', `HTTP_PROXY=${fallbackProxy}`,
      '-e', `HTTPS_PROXY=${fallbackProxy}`,
      '-e', `http_proxy=${fallbackProxy}`,
      '-e', `https_proxy=${fallbackProxy}`,
    );
  }

  baseArgs.push(args.dockerImage, 'uvx', 'harbor');

  return {
    cmd: 'docker',
    baseArgs,
    label: `docker(${args.dockerImage}) -> uvx harbor${usedHostNetwork ? ' [host-network]' : ''}`,
  };
}

function resolveRunner(args: CliArgs, cwdForRun: string): RunnerSpec {
  const fallbackProxy = resolveProxy(args);

  if (args.runner === 'harbor') {
    if (!hasCommand('harbor')) throw new Error('harbor not found for --runner=harbor');
    return { cmd: 'harbor', baseArgs: [], label: 'harbor' };
  }

  if (args.runner === 'uvx') {
    if (!hasCommand('uvx')) throw new Error('uvx not found for --runner=uvx');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UV_CACHE_DIR: process.env.UV_CACHE_DIR || '/tmp/uv-cache',
      UV_TOOL_DIR: process.env.UV_TOOL_DIR || '/tmp/uv-tools',
      XDG_DATA_HOME: process.env.XDG_DATA_HOME || '/tmp/xdg-data',
    };
    if (fallbackProxy) {
      env.HTTP_PROXY = fallbackProxy;
      env.HTTPS_PROXY = fallbackProxy;
      env.http_proxy = fallbackProxy;
      env.https_proxy = fallbackProxy;
    }
    return {
      cmd: 'uvx',
      baseArgs: ['--python', args.python, 'harbor'],
      label: `uvx harbor (python ${args.python})`,
      env,
    };
  }

  if (args.runner === 'docker') {
    return buildDockerRunner(args, cwdForRun);
  }

  // auto
  if (hasCommand('harbor')) {
    return { cmd: 'harbor', baseArgs: [], label: 'harbor' };
  }
  if (hasCommand('uvx')) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UV_CACHE_DIR: process.env.UV_CACHE_DIR || '/tmp/uv-cache',
      UV_TOOL_DIR: process.env.UV_TOOL_DIR || '/tmp/uv-tools',
      XDG_DATA_HOME: process.env.XDG_DATA_HOME || '/tmp/xdg-data',
    };
    if (fallbackProxy) {
      env.HTTP_PROXY = fallbackProxy;
      env.HTTPS_PROXY = fallbackProxy;
      env.http_proxy = fallbackProxy;
      env.https_proxy = fallbackProxy;
    }
    return {
      cmd: 'uvx',
      baseArgs: ['--python', args.python, 'harbor'],
      label: `uvx harbor (python ${args.python})`,
      env,
    };
  }
  return buildDockerRunner(args, cwdForRun);
}

function listDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map(name => path.join(root, name))
    .filter(p => fs.existsSync(p) && fs.statSync(p).isDirectory());
}

function findLatestJobDir(jobsDir: string, before: Set<string>): string {
  const after = listDirs(jobsDir);
  const created = after.filter(p => !before.has(path.resolve(p)));
  const candidates = created.length > 0 ? created : after;
  if (candidates.length === 0) {
    throw new Error(`No job directory found under ${jobsDir}`);
  }

  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

function findFilesRecursive(root: string, fileName: string): string[] {
  const out: string[] = [];
  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === fileName) out.push(full);
    }
  }
  walk(root);
  return out;
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickBooleanResult(obj: Record<string, any>): boolean | undefined {
  for (const k of ['success', 'passed', 'resolved', 'solved', 'is_success', 'is_passed', 'pass']) {
    if (typeof obj[k] === 'boolean') return obj[k];
  }
  for (const nk of ['result', 'outcome', 'evaluation', 'metrics', 'summary']) {
    const v = obj[nk];
    if (!isObject(v)) continue;
    for (const k of ['success', 'passed', 'resolved', 'solved', 'is_success', 'is_passed', 'pass']) {
      if (typeof v[k] === 'boolean') return v[k];
    }
  }
  return undefined;
}

function pickResultFromRewardFile(resultJsonPath: string): boolean | undefined {
  const rewardPath = path.join(path.dirname(resultJsonPath), 'verifier', 'reward.txt');
  if (!fs.existsSync(rewardPath)) return undefined;
  try {
    const n = Number(fs.readFileSync(rewardPath, 'utf-8').trim());
    if (!Number.isFinite(n)) return undefined;
    return n > 0;
  } catch {
    return undefined;
  }
}

function scoreJob(jobPath: string): { passed: number; total: number; unknown: number } {
  const summaryPath = path.resolve(jobPath, 'result.json');
  const allResultFiles = findFilesRecursive(jobPath, 'result.json');
  if (allResultFiles.length === 0) {
    throw new Error(`No result.json found under job path: ${jobPath}`);
  }
  // Exclude Harbor's top-level summary file from per-trial scoring.
  const resultFiles = allResultFiles
    .map(p => path.resolve(p))
    .filter(p => p !== summaryPath);

  let passed = 0;
  let total = 0;
  let unknown = 0;

  for (const file of resultFiles) {
    try {
      const data = readJson(file);
      if (!isObject(data)) {
        unknown += 1;
        continue;
      }
      let ok = pickBooleanResult(data);
      if (typeof ok !== 'boolean') ok = pickResultFromRewardFile(file);

      if (typeof ok === 'boolean') {
        total += 1;
        if (ok) passed += 1;
      } else {
        unknown += 1;
      }
    } catch {
      unknown += 1;
    }
  }

  if (total === 0) {
    if (!fs.existsSync(summaryPath)) {
      throw new Error(`No parseable pass/fail result found under job path: ${jobPath}`);
    }

    try {
      const summary = readJson(summaryPath);
      const nTotal = typeof summary?.n_total_trials === 'number' ? summary.n_total_trials : undefined;
      const evals = summary?.stats?.evals;
      if (isObject(evals)) {
        const firstEval = Object.values(evals)[0] as any;
        const mean = typeof firstEval?.metrics?.[0]?.mean === 'number' ? firstEval.metrics[0].mean : undefined;
        const nErrors = typeof firstEval?.n_errors === 'number' ? firstEval.n_errors : 0;
        const nTrials = typeof firstEval?.n_trials === 'number' ? firstEval.n_trials : 0;
        const totalFromSummary = nTotal ?? (nTrials + nErrors);
        if (typeof mean === 'number' && totalFromSummary > 0) {
          const approxPassed = Math.round(mean * totalFromSummary);
          return {
            passed: approxPassed,
            total: totalFromSummary,
            unknown: 0,
          };
        }
      }
    } catch {
      // ignore fallback parse errors and throw the original message
    }

    throw new Error(`No parseable pass/fail result found under job path: ${jobPath}`);
  }

  return { passed, total, unknown };
}

function runOfficialTB2(args: CliArgs): string {
  const harborArgs: string[] = ['run', '-d', args.dataset];
  if (args.model) harborArgs.push('-m', args.model);
  harborArgs.push('-a', args.agent);

  fs.mkdirSync(args.jobsDir, { recursive: true });
  const before = new Set(listDirs(args.jobsDir).map(p => path.resolve(p)));

  // Harbor uses ./jobs by default; run in jobs parent so artifacts are predictable.
  const cwdForRun = path.dirname(args.jobsDir);
  const runner = resolveRunner(args, cwdForRun);
  const fullArgs = [...runner.baseArgs, ...harborArgs];

  console.log(`Runner: ${runner.label}`);
  console.log(`Running: ${runner.cmd} ${fullArgs.join(' ')}`);
  console.log(`Working dir: ${cwdForRun}`);

  const run = spawnSync(runner.cmd, fullArgs, {
    cwd: cwdForRun,
    env: runner.env ?? process.env,
    stdio: 'inherit',
  });

  if (run.status !== 0) {
    throw new Error(`TB2 run failed with exit code ${run.status ?? 'unknown'}`);
  }

  return findLatestJobDir(args.jobsDir, before);
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

export interface TB2RunOptions {
  dataset: string;
  model?: string;
  agent: string;
  jobsDir: string;
  runner: 'auto' | 'harbor' | 'uvx' | 'docker';
  dockerImage: string;
  python: string;
  envFile?: string;
}

export function runTB2Official(options: TB2RunOptions): TB2Summary {
  const args: CliArgs = {
    dataset: options.dataset,
    model: options.model,
    agent: options.agent,
    jobsDir: path.resolve(options.jobsDir),
    runner: options.runner,
    dockerImage: options.dockerImage,
    python: options.python,
    envFile: options.envFile ? path.resolve(options.envFile) : undefined,
  };
  const defaultEnvFile = path.resolve(process.cwd(), '.env.test');
  if (!args.envFile && fs.existsSync(defaultEnvFile)) {
    args.envFile = defaultEnvFile;
  }

  const jobPath = runOfficialTB2(args);
  const s = scoreJob(jobPath);

  return {
    generated_at: new Date().toISOString(),
    dataset: args.dataset,
    agent: args.agent,
    model: args.model,
    jobs_dir: args.jobsDir,
    job_path: jobPath,
    passed: s.passed,
    total: s.total,
    rate: s.total > 0 ? s.passed / s.total : 0,
    unknown: s.unknown,
  };
}

function writeSummary(summary: TB2Summary, outputFile?: string): void {
  console.log('\n=== Terminal Bench 2.0 Score ===');
  console.log(`Job path: ${summary.job_path}`);
  console.log(`Passed:   ${summary.passed}/${summary.total}`);
  console.log(`Rate:     ${fmtPct(summary.rate)}`);
  console.log(`Unknown:  ${summary.unknown}`);

  if (outputFile) {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(summary, null, 2), 'utf-8');
    console.log(`Summary written to: ${outputFile}`);
  }
}

function main(): void {
  const args = parseCliArgs();
  const summary = runTB2Official({
    dataset: args.dataset,
    model: args.model,
    agent: args.agent,
    jobsDir: args.jobsDir,
    runner: args.runner,
    dockerImage: args.dockerImage,
    python: args.python,
    envFile: args.envFile,
  });
  writeSummary(summary, args.outputFile);
}

if (require.main === module) {
  try {
    main();
  } catch (err: any) {
    console.error('TB2 official run failed:', err?.message || String(err));
    process.exitCode = 1;
  }
}
