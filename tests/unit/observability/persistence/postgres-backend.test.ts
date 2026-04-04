import path from 'node:path';

import {
  PostgresStore,
  PostgresStoreObservationBackend,
} from '../../../../src';
import { TestRunner, expect } from '../../../helpers/utils';

const runner = new TestRunner('Observability Persistence Postgres Backend');

const TEST_STORE_DIR = path.join(__dirname, '../../../.tmp/postgres-observation-backend');
const PG_CONFIG = {
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5433'),
  database: process.env.POSTGRES_DB || 'kode_test',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'testpass123',
};

let store: PostgresStore | null = null;
let backend: PostgresStoreObservationBackend | null = null;
let skipTests = false;

async function checkPostgresAvailable(): Promise<boolean> {
  let testStore: PostgresStore | null = null;
  try {
    testStore = new PostgresStore(PG_CONFIG, TEST_STORE_DIR);
    await (testStore as any).initPromise;
    await testStore.list();
    await testStore.close();
    return true;
  } catch (error: any) {
    if (testStore) {
      try {
        await testStore.close();
      } catch {
        // ignore close error
      }
    }
    console.log(`  ⚠️  PostgreSQL observation backend 测试跳过: ${error.message}`);
    return false;
  }
}

runner
  .beforeAll(async () => {
    skipTests = !(await checkPostgresAvailable());
    if (skipTests) {
      return;
    }

    store = new PostgresStore(PG_CONFIG, TEST_STORE_DIR);
    backend = new PostgresStoreObservationBackend(store);
    await backend.prune();
    await (store as any).pool.query('DELETE FROM observations');
  })
  .afterAll(async () => {
    if (!store) {
      return;
    }
    await (store as any).pool.query('DELETE FROM observations');
    await store.close();
  });

runner.test('PostgresStoreObservationBackend persists and queries observations when PostgreSQL is available', async () => {
  if (skipTests || !store || !backend) {
    return;
  }

  await backend.append({
    seq: 0,
    timestamp: 1_710_000_000_000,
    observation: {
      kind: 'agent_run',
      agentId: 'agent-pg',
      runId: 'run-pg',
      traceId: 'trace-pg',
      spanId: 'span-pg',
      name: 'agent.run',
      status: 'ok',
      startTime: 1_710_000_000_000,
      endTime: 1_710_000_000_010,
      durationMs: 10,
      trigger: 'send',
      step: 1,
      messageCountBefore: 1,
      metadata: { templateId: 'template-pg' },
    },
  });

  const listed = await backend.list({ agentIds: ['agent-pg'] });
  expect.toHaveLength(listed, 1);
  expect.toEqual(listed[0].observation.runId, 'run-pg');
});

export async function run() {
  return runner.run();
}
