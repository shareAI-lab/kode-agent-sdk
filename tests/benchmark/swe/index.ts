// ---------------------------------------------------------------------------
// SWE benchmark module — BenchmarkModule entry point
// ---------------------------------------------------------------------------

import path from 'path';
import type { BenchmarkConfig, BenchmarkModuleResult, BenchmarkProvider, SWEProviderResult, SWEResult } from '../types';
import type { ModelProvider } from '../../../src/infra/providers/types';
import { AnthropicProvider } from '../../../src/infra/providers/anthropic';
import { OpenAIProvider } from '../../../src/infra/providers/openai';
import { GeminiProvider } from '../../../src/infra/providers/gemini';
import { loadMiniCases, loadCuratedInstances, MiniCase } from './dataset';
import { runHarness } from './harness';
import { evaluateCase, cleanupWorkDir } from './evaluator';
import {
  isDockerAvailable,
  generateFix,
  evaluateWithDocker,
  evaluateLocally,
  cleanupWorkDir as cleanupDockerWorkDir,
  type FullSWEInstance,
} from './docker-evaluator';

// Module metadata (used by run-benchmark.ts discovery)
export const name = 'swe';

// ---------------------------------------------------------------------------
// Provider creation (same pattern as TAU)
// ---------------------------------------------------------------------------

function createProvider(bp: BenchmarkProvider): ModelProvider {
  switch (bp.id) {
    case 'anthropic':
      return new AnthropicProvider(bp.apiKey, bp.model, bp.baseUrl, bp.proxyUrl);
    case 'openai':
      return new OpenAIProvider(bp.apiKey, bp.model, bp.baseUrl, bp.proxyUrl);
    case 'gemini':
      return new GeminiProvider(bp.apiKey, bp.model, bp.baseUrl, bp.proxyUrl);
    default:
      return new OpenAIProvider(bp.apiKey, bp.model, bp.baseUrl, bp.proxyUrl);
  }
}

// ---------------------------------------------------------------------------
// Run single provider on all mini-SWE cases
// ---------------------------------------------------------------------------

async function runProviderOnCases(
  bp: BenchmarkProvider,
  cases: MiniCase[],
  config: BenchmarkConfig,
): Promise<SWEProviderResult> {
  const provider = createProvider(bp);
  const results: SWEResult[] = [];

  for (const c of cases) {
    const startMs = Date.now();
    const workDir = path.join(
      process.cwd(),
      'tests',
      '.tmp',
      `swe-${bp.id}-${c.id}-${Date.now()}`,
    );

    try {
      // 1. Send to model
      const harness = await runHarness(provider, c);

      if (harness.error || Object.keys(harness.correctedFiles).length === 0) {
        const durationMs = Date.now() - startMs;
        const errMsg = harness.error || 'No corrected files returned';
        console.log(`    [${bp.id}] ${c.id}: FAIL (${errMsg})`);
        results.push({
          instance_id: c.id,
          resolved: false,
          tokens_used: harness.tokens,
          duration_ms: durationMs,
          error: errMsg,
        });
        continue;
      }

      // 2. Merge corrected files with original files
      const mergedFiles = { ...c.files };
      for (const [name, content] of Object.entries(harness.correctedFiles)) {
        mergedFiles[name] = content;
      }

      // 3. Evaluate (write files + run test)
      const evalResult = evaluateCase(mergedFiles, c.test_command, workDir);
      const durationMs = Date.now() - startMs;

      const status = evalResult.passed ? 'PASS' : 'FAIL';
      const detail = evalResult.passed ? '' : ` (${evalResult.error || evalResult.output})`;
      console.log(
        `    [${bp.id}] ${c.id}: ${status} (${harness.tokens} tokens, ${durationMs}ms)${detail}`,
      );

      results.push({
        instance_id: c.id,
        resolved: evalResult.passed,
        tokens_used: harness.tokens,
        duration_ms: durationMs,
        error: evalResult.passed ? undefined : evalResult.error,
      });
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      console.log(`    [${bp.id}] ${c.id}: FAIL (${err.message})`);
      results.push({
        instance_id: c.id,
        resolved: false,
        tokens_used: 0,
        duration_ms: durationMs,
        error: err.message || String(err),
      });
    } finally {
      cleanupWorkDir(workDir);
    }
  }

  const resolved = results.filter(r => r.resolved).length;
  const total = results.length;
  const avgTokens = total > 0 ? Math.round(results.reduce((s, r) => s + r.tokens_used, 0) / total) : 0;
  const avgDuration = total > 0 ? Math.round(results.reduce((s, r) => s + r.duration_ms, 0) / total) : 0;

  return {
    provider: bp,
    summary: {
      dataset: 'mini-swe',
      total,
      resolved,
      rate: total > 0 ? resolved / total : 0,
      avg_tokens: avgTokens,
      avg_duration_ms: avgDuration,
    },
    results,
  };
}

// ---------------------------------------------------------------------------
// Run single provider on full SWE-bench instances
// ---------------------------------------------------------------------------

async function runProviderOnFullInstances(
  bp: BenchmarkProvider,
  instances: FullSWEInstance[],
  useDocker: boolean,
  dockerProxy?: string,
): Promise<SWEProviderResult> {
  const provider = createProvider(bp);
  const results: SWEResult[] = [];

  for (const inst of instances) {
    const startMs = Date.now();
    const workDir = path.join(
      process.cwd(),
      'tests',
      '.tmp',
      `swe-full-${bp.id}-${inst.instance_id}-${Date.now()}`,
    );

    try {
      // 1. Generate fix from model (clone repo, read files, LLM, generate diff)
      console.log(`    [${bp.id}] ${inst.instance_id}: generating fix ...`);
      const harness = await generateFix(provider, inst, dockerProxy);

      if (harness.error || !harness.patch) {
        const durationMs = Date.now() - startMs;
        const errMsg = harness.error || 'No fix generated';
        console.log(`    [${bp.id}] ${inst.instance_id}: FAIL (${errMsg})`);
        results.push({
          instance_id: inst.instance_id,
          resolved: false,
          tokens_used: harness.tokens,
          duration_ms: durationMs,
          error: errMsg,
        });
        continue;
      }

      // 2. Evaluate the fix patch
      console.log(`    [${bp.id}] ${inst.instance_id}: fix generated (${harness.tokens} tokens), evaluating ...`);
      const evalResult = useDocker
        ? evaluateWithDocker(inst, harness.patch, workDir, dockerProxy)
        : evaluateLocally(inst, harness.patch, workDir);

      const durationMs = Date.now() - startMs;
      const status = evalResult.passed ? 'PASS' : 'FAIL';
      const detail = evalResult.passed ? '' : ` (${(evalResult.error || '').slice(0, 100)})`;
      console.log(
        `    [${bp.id}] ${inst.instance_id}: ${status} (${harness.tokens} tokens, ${durationMs}ms)${detail}`,
      );

      results.push({
        instance_id: inst.instance_id,
        resolved: evalResult.passed,
        tokens_used: harness.tokens,
        duration_ms: durationMs,
        error: evalResult.passed ? undefined : evalResult.error,
      });
    } catch (err: any) {
      const durationMs = Date.now() - startMs;
      console.log(`    [${bp.id}] ${inst.instance_id}: FAIL (${err.message})`);
      results.push({
        instance_id: inst.instance_id,
        resolved: false,
        tokens_used: 0,
        duration_ms: durationMs,
        error: err.message || String(err),
      });
    } finally {
      cleanupDockerWorkDir(workDir);
    }
  }

  const resolved = results.filter(r => r.resolved).length;
  const total = results.length;
  const avgTokens = total > 0 ? Math.round(results.reduce((s, r) => s + r.tokens_used, 0) / total) : 0;
  const avgDuration = total > 0 ? Math.round(results.reduce((s, r) => s + r.duration_ms, 0) / total) : 0;

  return {
    provider: bp,
    summary: {
      dataset: 'swe-bench-full',
      total,
      resolved,
      rate: total > 0 ? resolved / total : 0,
      avg_tokens: avgTokens,
      avg_duration_ms: avgDuration,
    },
    results,
  };
}

// ---------------------------------------------------------------------------
// Module entry point
// ---------------------------------------------------------------------------

export async function run(config: BenchmarkConfig): Promise<BenchmarkModuleResult> {
  if (config.sweMode === 'full') {
    return runFullMode(config);
  }

  const cases = loadMiniCases();
  if (cases.length === 0) {
    console.log('  SWE: no mini-SWE cases found');
    return {};
  }

  if (config.providers.length === 0) {
    console.log('  SWE: no providers configured, skipping');
    return {};
  }

  console.log(`\n  SWE mini mode: ${cases.length} cases`);

  const allResults: SWEProviderResult[] = [];

  for (const bp of config.providers) {
    console.log(`\n  Running provider: ${bp.id} / ${bp.model}`);
    const providerResult = await runProviderOnCases(bp, cases, config);
    allResults.push(providerResult);
  }

  return { swe: allResults };
}

async function runFullMode(config: BenchmarkConfig): Promise<BenchmarkModuleResult> {
  const instances = loadCuratedInstances();
  if (instances.length === 0) {
    console.log('  SWE: no curated instances found for full mode');
    return {};
  }

  if (config.providers.length === 0) {
    console.log('  SWE: no providers configured, skipping');
    return {};
  }

  const useDocker = isDockerAvailable();
  console.log(`\n  SWE full mode: ${instances.length} curated instances`);
  console.log(`  Docker: ${useDocker ? 'available (using Docker evaluation)' : 'not available (using local git-based evaluation)'}`);

  const allResults: SWEProviderResult[] = [];

  for (const bp of config.providers) {
    console.log(`\n  Running provider: ${bp.id} / ${bp.model}`);
    const providerResult = await runProviderOnFullInstances(bp, instances, useDocker, config.dockerProxy);
    allResults.push(providerResult);
  }

  return { swe: allResults };
}
