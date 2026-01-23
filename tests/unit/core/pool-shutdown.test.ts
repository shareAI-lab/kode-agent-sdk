/**
 * Tests for AgentPool graceful shutdown functionality
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentPool, GracefulShutdownOptions, ShutdownResult } from '../../../src/core/pool';
import { Agent } from '../../../src/core/agent';
import { JSONStore } from '../../../src/infra/store/json-store';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('AgentPool Graceful Shutdown', () => {
  let pool: AgentPool;
  let store: JSONStore;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `kode-pool-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    store = new JSONStore(testDir);

    // Mock dependencies
    const mockProvider = {
      chat: vi.fn().mockResolvedValue({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
      }),
      stream: vi.fn(),
    };

    pool = new AgentPool({
      dependencies: {
        store,
        modelProvider: mockProvider as any,
        sandbox: { run: vi.fn() } as any,
      },
      maxAgents: 10,
    });
  });

  afterEach(async () => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('gracefulShutdown', () => {
    it('should return empty result when pool is empty', async () => {
      const result = await pool.gracefulShutdown();

      expect(result.completed).toEqual([]);
      expect(result.interrupted).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should save running agents list when saveRunningList is true', async () => {
      // Create and add an agent to the pool
      const mockAgent = {
        status: vi.fn().mockResolvedValue({ state: 'READY' }),
        interrupt: vi.fn(),
      } as unknown as Agent;

      (pool as any).agents.set('test-agent-1', mockAgent);

      const result = await pool.gracefulShutdown({ saveRunningList: true });

      expect(result.completed).toContain('test-agent-1');

      // Verify running agents list was saved
      const savedInfo = await store.loadInfo('__pool_meta__');
      expect(savedInfo).toBeDefined();
      expect((savedInfo as any).runningAgents.agentIds).toContain('test-agent-1');
    });

    it('should not save running agents list when saveRunningList is false', async () => {
      const mockAgent = {
        status: vi.fn().mockResolvedValue({ state: 'READY' }),
        interrupt: vi.fn(),
      } as unknown as Agent;

      (pool as any).agents.set('test-agent-2', mockAgent);

      await pool.gracefulShutdown({ saveRunningList: false });

      // Verify running agents list was NOT saved
      const savedInfo = await store.loadInfo('__pool_meta__');
      expect(savedInfo).toBeUndefined();
    });

    it('should interrupt working agents after timeout', async () => {
      const interruptMock = vi.fn().mockResolvedValue(undefined);
      const mockAgent = {
        status: vi.fn().mockResolvedValue({ state: 'WORKING' }),
        interrupt: interruptMock,
      } as unknown as Agent;

      (pool as any).agents.set('working-agent', mockAgent);

      const result = await pool.gracefulShutdown({
        timeout: 100, // Very short timeout
        forceInterrupt: true,
      });

      expect(interruptMock).toHaveBeenCalledWith({ note: 'Graceful shutdown timeout' });
      expect(result.interrupted).toContain('working-agent');
    });
  });

  describe('resumeFromShutdown', () => {
    it('should return empty array when no running agents list exists', async () => {
      const configFactory = (agentId: string) => ({
        agentId,
        template: { systemPrompt: 'test' },
      });

      const resumed = await pool.resumeFromShutdown(configFactory);

      expect(resumed).toEqual([]);
    });

    it('should clear running agents list after resume', async () => {
      // Manually save a running agents list
      await store.saveInfo('__pool_meta__', {
        agentId: '__pool_meta__',
        templateId: '__pool_meta__',
        createdAt: new Date().toISOString(),
        runningAgents: {
          agentIds: ['non-existent-agent'],
          shutdownAt: new Date().toISOString(),
          version: '1.0.0',
        },
      } as any);

      const configFactory = (agentId: string) => ({
        agentId,
        template: { systemPrompt: 'test' },
      });

      // Resume will fail for non-existent agent, but should still clear the list
      await pool.resumeFromShutdown(configFactory);

      // Verify the list was cleared
      const savedInfo = await store.loadInfo('__pool_meta__');
      expect(savedInfo).toBeUndefined();
    });
  });

  describe('registerShutdownHandlers', () => {
    it('should register SIGTERM and SIGINT handlers', () => {
      const onSpy = vi.spyOn(process, 'on');

      pool.registerShutdownHandlers();

      expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

      onSpy.mockRestore();
    });
  });
});
