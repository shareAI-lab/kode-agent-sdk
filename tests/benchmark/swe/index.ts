import path from 'path';
import type { BenchmarkConfig, BenchmarkModuleResult, BenchmarkProvider, SWEProviderResult, SWEResult } from '../types';
import type { ModelProvider } from '../../../src/infra/providers/types';
import { AnthropicProvider } from '../../../src/infra/providers/anthropic';
import { OpenAIProvider } from '../../../src/infra/providers/openai';
import { GeminiProvider } from '../../../src/infra/providers/gemini';
import { loadVerifiedInstances } from './dataset';
import {
  isDockerAvailable,
  generateFix,
  evaluateWithDocker,
  cleanupWorkDir,
  type FullSWEInstance,
} from './docker-evaluator';

export const name = 'swe';

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

async function runProviderOnVerifiedInstances(
  bp: BenchmarkProvider,
  instances: FullSWEInstance[],
  dockerProxy?: string,
): Promise<SWEProviderResult> {
  const provider = createProvider(bp);
  const results: SWEResult[] = [];

  for (const inst of instances) {
    const startMs = Date.now();
    const workDir = path.join(process.cwd(), 'tests', '.tmp', `swe-${bp.id}-${inst.instance_id}-${Date.now()}`);

    try {
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

      console.log(`    [${bp.id}] ${inst.instance_id}: fix generated (${harness.tokens} tokens), evaluating ...`);
      const evalResult = evaluateWithDocker(inst, harness.patch, workDir, dockerProxy);

      const durationMs = Date.now() - startMs;
      const status = evalResult.passed ? 'PASS' : 'FAIL';
      const detail = evalResult.passed ? '' : ` (${(evalResult.error || '').slice(0, 120)})`;
      console.log(`    [${bp.id}] ${inst.instance_id}: ${status} (${harness.tokens} tokens, ${durationMs}ms)${detail}`);

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
      dataset: 'swe-bench-verified',
      total,
      resolved,
      rate: total > 0 ? resolved / total : 0,
      avg_tokens: avgTokens,
      avg_duration_ms: avgDuration,
    },
    results,
  };
}

export async function run(config: BenchmarkConfig): Promise<BenchmarkModuleResult> {
  const instances = loadVerifiedInstances();
  if (instances.length === 0) {
    console.log('  SWE: no verified instances found');
    return {};
  }

  if (config.providers.length === 0) {
    console.log('  SWE: no providers configured, skipping');
    return {};
  }

  const dockerAvailable = isDockerAvailable();
  if (!dockerAvailable) {
    console.log('  SWE: Docker is required for SWE-bench-Verified and is not available. Skipping.');
    return {};
  }

  console.log(`\n  SWE verified mode: ${instances.length} instances`);
  console.log('  Docker: available (official SWE image evaluation)');

  const allResults: SWEProviderResult[] = [];
  for (const bp of config.providers) {
    console.log(`\n  Running provider: ${bp.id} / ${bp.model}`);
    const providerResult = await runProviderOnVerifiedInstances(bp, instances, config.dockerProxy);
    allResults.push(providerResult);
  }

  return { swe: allResults };
}
