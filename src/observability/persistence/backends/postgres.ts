import type { Pool } from 'pg';

import type { PostgresStore } from '../../../infra/db/postgres/postgres-store';
import type { ObservationEnvelope } from '../../types';
import {
  buildPersistedObservationRunView,
  filterPersistedObservationEnvelopes,
} from '../reader';
import type {
  ObservationPruneResult,
  ObservationQueryBackend,
  ObservationRetentionPolicy,
  PersistedObservationListOptions,
} from '../types';

type PostgresObservationRow = {
  id: number;
  agent_id: string;
  seq: number;
  timestamp: number;
  envelope: ObservationEnvelope;
};

export class PostgresStoreObservationBackend implements ObservationQueryBackend {
  private readonly pool: Pool;
  private readonly schemaReady: Promise<void>;

  constructor(store: PostgresStore) {
    const internal = store as any;
    this.pool = internal.pool as Pool;
    const initPromise = internal.initPromise as Promise<void>;
    this.schemaReady = initPromise.then(() => this.initialize());
  }

  async append(envelope: ObservationEnvelope): Promise<void> {
    await this.ensureReady();

    const observation = envelope.observation;
    const templateId =
      observation.metadata?.templateId && typeof observation.metadata.templateId === 'string'
        ? observation.metadata.templateId
        : null;

    await this.pool.query(
      `INSERT INTO observations (
        agent_id, run_id, trace_id, parent_span_id, kind, status, seq, timestamp, template_id, envelope
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        observation.agentId,
        observation.runId,
        observation.traceId,
        observation.parentSpanId ?? null,
        observation.kind,
        observation.status,
        envelope.seq,
        envelope.timestamp,
        templateId,
        JSON.stringify(envelope),
      ]
    );
  }

  async list(opts?: PersistedObservationListOptions): Promise<ObservationEnvelope[]> {
    await this.ensureReady();
    const rows = await this.queryRows(opts);
    const envelopes = rows.map((row) => row.envelope);
    return filterPersistedObservationEnvelopes(envelopes, opts);
  }

  async getRun(runId: string) {
    await this.ensureReady();
    const rows = await this.queryRows({ runId });
    const envelopes = rows.map((row) => row.envelope);
    return buildPersistedObservationRunView(envelopes, runId);
  }

  async prune(policy?: ObservationRetentionPolicy): Promise<ObservationPruneResult> {
    await this.ensureReady();

    if (!policy) {
      const retained = Number((await this.pool.query('SELECT COUNT(*)::int AS count FROM observations')).rows[0].count);
      return { deleted: 0, retained };
    }

    let deleted = 0;

    if (policy.maxAgeMs !== undefined) {
      const cutoff = Date.now() - Math.max(0, policy.maxAgeMs);
      const result = await this.pool.query('DELETE FROM observations WHERE timestamp < $1', [cutoff]);
      deleted += result.rowCount ?? 0;
    }

    if (policy.maxEntriesPerAgent !== undefined) {
      const maxEntries = Math.max(1, Math.floor(policy.maxEntriesPerAgent));
      const rows = await this.pool.query<{
        id: number;
        agent_id: string;
      }>(
        `SELECT id, agent_id
         FROM observations
         ORDER BY agent_id ASC, timestamp DESC, seq DESC, id DESC`
      );

      const counts = new Map<string, number>();
      const idsToDelete: number[] = [];

      for (const row of rows.rows) {
        const next = (counts.get(row.agent_id) ?? 0) + 1;
        counts.set(row.agent_id, next);
        if (next > maxEntries) {
          idsToDelete.push(row.id);
        }
      }

      if (idsToDelete.length > 0) {
        const result = await this.pool.query('DELETE FROM observations WHERE id = ANY($1::bigint[])', [idsToDelete]);
        deleted += result.rowCount ?? 0;
      }
    }

    const retained = Number((await this.pool.query('SELECT COUNT(*)::int AS count FROM observations')).rows[0].count);
    return { deleted, retained };
  }

  private async ensureReady(): Promise<void> {
    await this.schemaReady;
  }

  private async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS observations (
        id BIGSERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        parent_span_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp BIGINT NOT NULL,
        template_id TEXT,
        envelope JSONB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id);
      CREATE INDEX IF NOT EXISTS idx_observations_run_id ON observations(run_id);
      CREATE INDEX IF NOT EXISTS idx_observations_trace_id ON observations(trace_id);
      CREATE INDEX IF NOT EXISTS idx_observations_kind ON observations(kind);
      CREATE INDEX IF NOT EXISTS idx_observations_status ON observations(status);
      CREATE INDEX IF NOT EXISTS idx_observations_template_id ON observations(template_id);
      CREATE INDEX IF NOT EXISTS idx_observations_timestamp ON observations(timestamp DESC);
    `);
  }

  private async queryRows(opts?: PersistedObservationListOptions): Promise<PostgresObservationRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let index = 1;

    const agentIds = this.resolveAgentIds(opts);
    if (agentIds.length > 0) {
      clauses.push(`agent_id = ANY($${index++}::text[])`);
      params.push(agentIds);
    }
    if (opts?.runId) {
      clauses.push(`run_id = $${index++}`);
      params.push(opts.runId);
    }
    if (opts?.traceId) {
      clauses.push(`trace_id = $${index++}`);
      params.push(opts.traceId);
    }
    if (opts?.parentSpanId) {
      clauses.push(`parent_span_id = $${index++}`);
      params.push(opts.parentSpanId);
    }
    if (opts?.kinds?.length) {
      clauses.push(`kind = ANY($${index++}::text[])`);
      params.push(opts.kinds);
    }
    if (opts?.statuses?.length) {
      clauses.push(`status = ANY($${index++}::text[])`);
      params.push(opts.statuses);
    }
    if (opts?.templateIds?.length) {
      clauses.push(`template_id = ANY($${index++}::text[])`);
      params.push(opts.templateIds);
    }
    if (opts?.fromTimestamp !== undefined) {
      clauses.push(`timestamp >= $${index++}`);
      params.push(opts.fromTimestamp);
    }
    if (opts?.toTimestamp !== undefined) {
      clauses.push(`timestamp <= $${index++}`);
      params.push(opts.toTimestamp);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query<PostgresObservationRow>(
      `SELECT id, agent_id, seq, timestamp, envelope
       FROM observations
       ${where}
       ORDER BY timestamp ASC, agent_id ASC, seq ASC, id ASC`,
      params
    );
    return result.rows;
  }

  private resolveAgentIds(opts?: PersistedObservationListOptions): string[] {
    const ids = new Set<string>();
    if (opts?.agentId) {
      ids.add(opts.agentId);
    }
    for (const agentId of opts?.agentIds ?? []) {
      ids.add(agentId);
    }
    return [...ids];
  }
}
