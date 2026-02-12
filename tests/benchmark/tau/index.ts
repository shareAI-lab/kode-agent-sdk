// ---------------------------------------------------------------------------
// TAU benchmark module — BenchmarkModule entry point
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import type { BenchmarkConfig, BenchmarkModuleResult, BenchmarkProvider, TAUProviderResult, TAUTaskResult } from '../types';
import type { ModelProvider } from '../../../src/infra/providers/types';
import { AnthropicProvider } from '../../../src/infra/providers/anthropic';
import { OpenAIProvider } from '../../../src/infra/providers/openai';
import { GeminiProvider } from '../../../src/infra/providers/gemini';
import { getInitialDatabase as getAirlineDb } from './domains/airline/database';
import { getAirlineToolDefs } from './domains/airline/tools';
import { getAirlineHandlers } from './domains/airline/handlers';
import { getInitialDatabase as getRetailDb } from './domains/retail/database';
import { getRetailToolDefs } from './domains/retail/tools';
import { getRetailHandlers } from './domains/retail/handlers';
import type { ToolHandler } from './environment';
import { Environment } from './environment';
import { UserSimulator } from './user-simulator';
import { runOrchestration } from './orchestrator';
import { evaluateDBState, computePassK } from './evaluator';

// Module metadata (used by run-benchmark.ts discovery)
export const name = 'tau';

// ---------------------------------------------------------------------------
// Domain loading
// ---------------------------------------------------------------------------

interface DomainData {
  id: string;
  policy: string;
  toolDefs: any[];
  getInitialDatabase: () => any;
  getHandlers: () => Record<string, ToolHandler>;
  tasks: Array<{
    task_id: string;
    user_scenario: string;
    expected_db: Record<string, any[]>;
    max_turns: number;
  }>;
}

function loadDomain(domainId: string): DomainData | null {
  const domainDir = path.join(__dirname, 'domains', domainId);
  const policyPath = path.join(domainDir, 'policy.md');
  const tasksPath = path.join(domainDir, 'tasks.json');

  if (!fs.existsSync(policyPath) || !fs.existsSync(tasksPath)) return null;

  const policy = fs.readFileSync(policyPath, 'utf-8');
  const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));

  switch (domainId) {
    case 'airline':
      return {
        id: domainId,
        policy,
        toolDefs: getAirlineToolDefs(),
        getInitialDatabase: getAirlineDb,
        getHandlers: getAirlineHandlers,
        tasks,
      };
    case 'retail':
      return {
        id: domainId,
        policy,
        toolDefs: getRetailToolDefs(),
        getInitialDatabase: getRetailDb,
        getHandlers: getRetailHandlers,
        tasks,
      };
    default:
      return null;
  }
}

function getAvailableDomains(tauDomain: string): DomainData[] {
  const domains: DomainData[] = [];
  const candidates = tauDomain === 'all' ? ['airline', 'retail'] : [tauDomain];

  for (const id of candidates) {
    const domain = loadDomain(id);
    if (domain) domains.push(domain);
  }

  return domains;
}

// ---------------------------------------------------------------------------
// Provider creation
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
      // For glm, minimax, etc. — try OpenAI-compatible
      return new OpenAIProvider(bp.apiKey, bp.model, bp.baseUrl, bp.proxyUrl);
  }
}

// ---------------------------------------------------------------------------
// Build system prompt
// ---------------------------------------------------------------------------

const DOMAIN_ROLES: Record<string, string> = {
  airline: 'an airline customer service agent',
  retail: 'an online retail customer service agent',
};

function buildSystemPrompt(domainId: string, policy: string, toolDefs: any[]): string {
  const role = DOMAIN_ROLES[domainId] || 'a customer service agent';
  const toolList = toolDefs.map(t => `- ${t.name}: ${t.description}`).join('\n');
  return [
    `You are ${role}. Follow the policy below strictly.`,
    '',
    '--- POLICY ---',
    policy,
    '--- END POLICY ---',
    '',
    'Available tools:',
    toolList,
    '',
    'Instructions:',
    '- Use tools to look up and modify data. Do not guess or make up information.',
    '- When the customer\'s issue is fully resolved, include "###STOP###" at the end of your final message.',
    '- Be concise and professional.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Run single provider across a domain
// ---------------------------------------------------------------------------

async function runProviderOnDomain(
  bp: BenchmarkProvider,
  userSimBp: BenchmarkProvider,
  domain: DomainData,
  config: BenchmarkConfig,
): Promise<TAUProviderResult> {
  const agentProvider = createProvider(bp);
  const userSimProvider = createProvider(userSimBp);
  const systemPrompt = buildSystemPrompt(domain.id, domain.policy, domain.toolDefs);
  const results: TAUTaskResult[] = [];

  // Collect pass/fail per task across trials for pass^k calculation
  const taskTrialMatrix: boolean[][] = [];

  for (const task of domain.tasks) {
    const trialResults: boolean[] = [];
    let totalTokens = 0;
    let lastError: string | undefined;

    for (let trial = 0; trial < config.numTrials; trial++) {
      // Fresh environment for each trial
      const env = new Environment(domain.getInitialDatabase(), domain.getHandlers());
      const userSim = new UserSimulator(userSimProvider, task.user_scenario);

      const orchResult = await runOrchestration({
        agentProvider,
        userSimulator: userSim,
        environment: env,
        systemPrompt,
        toolDefs: domain.toolDefs,
        maxTurns: task.max_turns,
        timeoutMs: config.timeoutMs,
        expectedDb: task.expected_db,
        evaluate: evaluateDBState,
      });

      trialResults.push(orchResult.passed);
      totalTokens += orchResult.agentTokens;
      if (orchResult.error) lastError = orchResult.error;

      // Log progress
      const status = orchResult.passed ? 'PASS' : 'FAIL';
      const errorSuffix = orchResult.error ? ` (${orchResult.error})` : '';
      console.log(
        `    [${bp.id}] ${task.task_id} trial ${trial + 1}/${config.numTrials}: ${status} (${orchResult.turns} turns, ${orchResult.agentTokens} tokens)${errorSuffix}`,
      );
    }

    taskTrialMatrix.push(trialResults);
    results.push({
      task_id: task.task_id,
      trial_pass_rates: trialResults,
      tokens_used: Math.round(totalTokens / config.numTrials),
      error: trialResults.every(r => !r) ? lastError : undefined,
    });
  }

  // Compute pass^k
  const passAtK = computePassK(taskTrialMatrix, config.numTrials);
  const avgTokens =
    results.length > 0 ? Math.round(results.reduce((s, r) => s + r.tokens_used, 0) / results.length) : 0;

  return {
    provider: bp,
    summary: {
      domain: domain.id,
      total_tasks: domain.tasks.length,
      num_trials: config.numTrials,
      pass_at_k: passAtK,
      avg_tokens: avgTokens,
    },
    results,
  };
}

// ---------------------------------------------------------------------------
// Module entry point
// ---------------------------------------------------------------------------

export async function run(config: BenchmarkConfig): Promise<BenchmarkModuleResult> {
  const domains = getAvailableDomains(config.tauDomain);

  if (domains.length === 0) {
    console.log(`  TAU: no domains found for "${config.tauDomain}"`);
    return {};
  }

  if (config.providers.length === 0) {
    console.log('  TAU: no providers configured, skipping');
    return {};
  }

  const allResults: TAUProviderResult[] = [];

  for (const domain of domains) {
    console.log(`\n  TAU domain: ${domain.id} (${domain.tasks.length} tasks, ${config.numTrials} trials)`);

    for (const bp of config.providers) {
      // Use userSimProvider if configured, otherwise same as agent provider
      const userSimBp = config.userSimProvider ?? bp;

      console.log(`\n  Running provider: ${bp.id} / ${bp.model}`);
      console.log(`  User simulator:   ${userSimBp.id} / ${userSimBp.model}`);

      const providerResult = await runProviderOnDomain(bp, userSimBp, domain, config);
      allResults.push(providerResult);
    }
  }

  return { tau: allResults };
}
