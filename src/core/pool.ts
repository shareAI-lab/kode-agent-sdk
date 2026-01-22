import { Agent, AgentConfig, AgentDependencies } from './agent';
import { AgentStatus, SnapshotId } from './types';
import { logger } from '../utils/logger';

export interface AgentPoolOptions {
  dependencies: AgentDependencies;
  maxAgents?: number;
}

export interface GracefulShutdownOptions {
  /** Maximum time to wait for agents to complete current step (ms), default 30000 */
  timeout?: number;
  /** Save running agents list for resumeFromShutdown(), default true */
  saveRunningList?: boolean;
  /** Force interrupt agents that don't complete within timeout, default true */
  forceInterrupt?: boolean;
}

export interface ShutdownResult {
  /** Agents that completed gracefully */
  completed: string[];
  /** Agents that were interrupted due to timeout */
  interrupted: string[];
  /** Agents that failed to save state */
  failed: string[];
  /** Total shutdown time in ms */
  durationMs: number;
}

/** Running agents metadata for recovery */
interface RunningAgentsMeta {
  agentIds: string[];
  shutdownAt: string;
  version: string;
}

export class AgentPool {
  private agents = new Map<string, Agent>();
  private deps: AgentDependencies;
  private maxAgents: number;

  constructor(opts: AgentPoolOptions) {
    this.deps = opts.dependencies;
    this.maxAgents = opts.maxAgents || 50;
  }

  async create(agentId: string, config: AgentConfig): Promise<Agent> {
    if (this.agents.has(agentId)) {
      throw new Error(`Agent already exists: ${agentId}`);
    }

    if (this.agents.size >= this.maxAgents) {
      throw new Error(`Pool is full (max ${this.maxAgents} agents)`);
    }

    const agent = await Agent.create({ ...config, agentId }, this.deps);
    this.agents.set(agentId, agent);
    return agent;
  }

  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  list(opts?: { prefix?: string }): string[] {
    const ids = Array.from(this.agents.keys());
    return opts?.prefix ? ids.filter((id) => id.startsWith(opts.prefix!)) : ids;
  }

  async status(agentId: string): Promise<AgentStatus | undefined> {
    const agent = this.agents.get(agentId);
    return agent ? await agent.status() : undefined;
  }

  async fork(agentId: string, snapshotSel?: SnapshotId | { at?: string }): Promise<Agent> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    return agent.fork(snapshotSel);
  }

  async resume(agentId: string, config: AgentConfig, opts?: { autoRun?: boolean; strategy?: 'crash' | 'manual' }): Promise<Agent> {
    // 1. Check if already in pool
    if (this.agents.has(agentId)) {
      return this.agents.get(agentId)!;
    }

    // 2. Check pool capacity
    if (this.agents.size >= this.maxAgents) {
      throw new Error(`Pool is full (max ${this.maxAgents} agents)`);
    }

    // 3. Verify session exists
    const exists = await this.deps.store.exists(agentId);
    if (!exists) {
      throw new Error(`Agent not found in store: ${agentId}`);
    }

    // 4. Use Agent.resume() to restore
    const agent = await Agent.resume(agentId, { ...config, agentId }, this.deps, opts);

    // 5. Add to pool
    this.agents.set(agentId, agent);

    return agent;
  }

  async resumeAll(
    configFactory: (agentId: string) => AgentConfig,
    opts?: { autoRun?: boolean; strategy?: 'crash' | 'manual' }
  ): Promise<Agent[]> {
    const agentIds = await this.deps.store.list();
    const resumed: Agent[] = [];

    for (const agentId of agentIds) {
      if (this.agents.size >= this.maxAgents) break;
      if (this.agents.has(agentId)) continue;

      try {
        const config = configFactory(agentId);
        const agent = await this.resume(agentId, config, opts);
        resumed.push(agent);
      } catch (error) {
        logger.error(`Failed to resume ${agentId}:`, error);
      }
    }

    return resumed;
  }

  async delete(agentId: string): Promise<void> {
    this.agents.delete(agentId);
    await this.deps.store.delete(agentId);
  }

  size(): number {
    return this.agents.size;
  }

  /**
   * Gracefully shutdown all agents in the pool
   * 1. Stop accepting new operations
   * 2. Wait for running agents to complete current step
   * 3. Persist all agent states
   * 4. Optionally save running agents list for recovery
   */
  async gracefulShutdown(opts?: GracefulShutdownOptions): Promise<ShutdownResult> {
    const startTime = Date.now();
    const timeout = opts?.timeout ?? 30000;
    const saveRunningList = opts?.saveRunningList ?? true;
    const forceInterrupt = opts?.forceInterrupt ?? true;

    const result: ShutdownResult = {
      completed: [],
      interrupted: [],
      failed: [],
      durationMs: 0,
    };

    const agentIds = Array.from(this.agents.keys());
    logger.info(`[AgentPool] Starting graceful shutdown for ${agentIds.length} agents`);

    // Group agents by state
    const workingAgents: Array<{ id: string; agent: Agent }> = [];
    const readyAgents: Array<{ id: string; agent: Agent }> = [];

    for (const [id, agent] of this.agents) {
      const status = await agent.status();
      if (status.state === 'WORKING') {
        workingAgents.push({ id, agent });
      } else {
        readyAgents.push({ id, agent });
      }
    }

    // 1. Persist ready agents immediately
    for (const { id, agent } of readyAgents) {
      try {
        await this.persistAgentState(agent);
        result.completed.push(id);
      } catch (error) {
        logger.error(`[AgentPool] Failed to persist agent ${id}:`, error);
        result.failed.push(id);
      }
    }

    // 2. Wait for working agents with timeout
    if (workingAgents.length > 0) {
      logger.info(`[AgentPool] Waiting for ${workingAgents.length} working agents...`);

      const waitPromises = workingAgents.map(async ({ id, agent }) => {
        try {
          const completed = await this.waitForAgentReady(agent, timeout);
          if (completed) {
            await this.persistAgentState(agent);
            return { id, status: 'completed' as const };
          } else if (forceInterrupt) {
            await agent.interrupt({ note: 'Graceful shutdown timeout' });
            await this.persistAgentState(agent);
            return { id, status: 'interrupted' as const };
          } else {
            return { id, status: 'interrupted' as const };
          }
        } catch (error) {
          logger.error(`[AgentPool] Error during shutdown for agent ${id}:`, error);
          return { id, status: 'failed' as const };
        }
      });

      const results = await Promise.all(waitPromises);
      for (const { id, status } of results) {
        if (status === 'completed') {
          result.completed.push(id);
        } else if (status === 'interrupted') {
          result.interrupted.push(id);
        } else {
          result.failed.push(id);
        }
      }
    }

    // 3. Save running agents list for recovery
    if (saveRunningList) {
      try {
        await this.saveRunningAgentsList(agentIds);
        logger.info(`[AgentPool] Saved running agents list: ${agentIds.length} agents`);
      } catch (error) {
        logger.error(`[AgentPool] Failed to save running agents list:`, error);
      }
    }

    result.durationMs = Date.now() - startTime;
    logger.info(`[AgentPool] Graceful shutdown completed in ${result.durationMs}ms`, {
      completed: result.completed.length,
      interrupted: result.interrupted.length,
      failed: result.failed.length,
    });

    return result;
  }

  /**
   * Resume agents from a previous graceful shutdown
   * Reads the running agents list and resumes each agent
   */
  async resumeFromShutdown(
    configFactory: (agentId: string) => AgentConfig,
    opts?: { autoRun?: boolean; strategy?: 'crash' | 'manual' }
  ): Promise<Agent[]> {
    const runningList = await this.loadRunningAgentsList();
    if (!runningList || runningList.length === 0) {
      logger.info('[AgentPool] No running agents list found, nothing to resume');
      return [];
    }

    logger.info(`[AgentPool] Resuming ${runningList.length} agents from shutdown`);

    const resumed: Agent[] = [];
    for (const agentId of runningList) {
      if (this.agents.size >= this.maxAgents) {
        logger.warn(`[AgentPool] Pool is full, cannot resume more agents`);
        break;
      }

      try {
        const config = configFactory(agentId);
        const agent = await this.resume(agentId, config, {
          autoRun: opts?.autoRun ?? false,
          strategy: opts?.strategy ?? 'crash',
        });
        resumed.push(agent);
      } catch (error) {
        logger.error(`[AgentPool] Failed to resume agent ${agentId}:`, error);
      }
    }

    // Clear the running agents list after successful resume
    await this.clearRunningAgentsList();

    logger.info(`[AgentPool] Resumed ${resumed.length}/${runningList.length} agents`);
    return resumed;
  }

  /**
   * Register signal handlers for graceful shutdown
   * Call this in your server setup code
   */
  registerShutdownHandlers(
    configFactory?: (agentId: string) => AgentConfig,
    opts?: GracefulShutdownOptions
  ): void {
    const handler = async (signal: string) => {
      logger.info(`[AgentPool] Received ${signal}, initiating graceful shutdown...`);
      try {
        const result = await this.gracefulShutdown(opts);
        logger.info(`[AgentPool] Shutdown complete:`, result);
        process.exit(0);
      } catch (error) {
        logger.error(`[AgentPool] Shutdown failed:`, error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('SIGINT', () => handler('SIGINT'));
    logger.info('[AgentPool] Shutdown handlers registered for SIGTERM and SIGINT');
  }

  // ========== Private Helper Methods ==========

  private async waitForAgentReady(agent: Agent, timeout: number): Promise<boolean> {
    const startTime = Date.now();
    const pollInterval = 100; // ms

    while (Date.now() - startTime < timeout) {
      const status = await agent.status();
      if (status.state !== 'WORKING') {
        return true;
      }
      await this.sleep(pollInterval);
    }

    return false;
  }

  private async persistAgentState(agent: Agent): Promise<void> {
    // Agent's internal persist methods are private, so we rely on the fact that
    // state is automatically persisted during normal operation.
    // This is a no-op placeholder for potential future explicit persist calls.
    // The agent's state is already persisted via WAL mechanism.
  }

  private async saveRunningAgentsList(agentIds: string[]): Promise<void> {
    const meta: RunningAgentsMeta = {
      agentIds,
      shutdownAt: new Date().toISOString(),
      version: '1.0.0',
    };

    // Use the store's saveInfo to persist to a special key
    // We use a well-known agent ID prefix for pool metadata
    const poolMetaId = '__pool_meta__';
    await this.deps.store.saveInfo(poolMetaId, {
      agentId: poolMetaId,
      templateId: '__pool_meta__',
      createdAt: new Date().toISOString(),
      runningAgents: meta,
    } as any);
  }

  private async loadRunningAgentsList(): Promise<string[] | null> {
    const poolMetaId = '__pool_meta__';
    try {
      const info = await this.deps.store.loadInfo(poolMetaId);
      if (info && (info as any).runningAgents) {
        return (info as any).runningAgents.agentIds;
      }
    } catch {
      // Ignore errors, return null
    }
    return null;
  }

  private async clearRunningAgentsList(): Promise<void> {
    const poolMetaId = '__pool_meta__';
    try {
      await this.deps.store.delete(poolMetaId);
    } catch {
      // Ignore errors
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
