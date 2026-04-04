import type Database from 'better-sqlite3';

import type { SqliteStore } from '../../../infra/db/sqlite/sqlite-store';
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

type SqliteObservationRow = {
  id: number;
  agent_id: string;
  seq: number;
  timestamp: number;
  envelope: string;
};

export class SqliteStoreObservationBackend implements ObservationQueryBackend {
  private readonly db: Database.Database;

  constructor(store: SqliteStore) {
    this.db = (store as any).db as Database.Database;
    this.initialize();
  }

  async append(envelope: ObservationEnvelope): Promise<void> {
    const observation = envelope.observation;
    const templateId =
      observation.metadata?.templateId && typeof observation.metadata.templateId === 'string'
        ? observation.metadata.templateId
        : null;

    this.db
      .prepare(
        `INSERT INTO observations (
          agent_id, run_id, trace_id, parent_span_id, kind, status, seq, timestamp, template_id, envelope
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        observation.agentId,
        observation.runId,
        observation.traceId,
        observation.parentSpanId ?? null,
        observation.kind,
        observation.status,
        envelope.seq,
        envelope.timestamp,
        templateId,
        JSON.stringify(envelope)
      );
  }

  async list(opts?: PersistedObservationListOptions): Promise<ObservationEnvelope[]> {
    const rows = this.queryRows(opts);
    const envelopes = rows.map((row) => JSON.parse(row.envelope) as ObservationEnvelope);
    return filterPersistedObservationEnvelopes(envelopes, opts);
  }

  async getRun(runId: string) {
    const rows = this.queryRows({ runId });
    const envelopes = rows.map((row) => JSON.parse(row.envelope) as ObservationEnvelope);
    return buildPersistedObservationRunView(envelopes, runId);
  }

  async prune(policy?: ObservationRetentionPolicy): Promise<ObservationPruneResult> {
    if (!policy) {
      const retained = (this.db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number }).count;
      return { deleted: 0, retained };
    }

    let deleted = 0;

    if (policy.maxAgeMs !== undefined) {
      const cutoff = Date.now() - Math.max(0, policy.maxAgeMs);
      const result = this.db.prepare('DELETE FROM observations WHERE timestamp < ?').run(cutoff);
      deleted += result.changes;
    }

    if (policy.maxEntriesPerAgent !== undefined) {
      const maxEntries = Math.max(1, Math.floor(policy.maxEntriesPerAgent));
      const rows = this.db
        .prepare(
          `SELECT id, agent_id, timestamp, seq
           FROM observations
           ORDER BY agent_id ASC, timestamp DESC, seq DESC, id DESC`
        )
        .all() as Array<{ id: number; agent_id: string; timestamp: number; seq: number }>;

      const counts = new Map<string, number>();
      const idsToDelete: number[] = [];

      for (const row of rows) {
        const next = (counts.get(row.agent_id) ?? 0) + 1;
        counts.set(row.agent_id, next);
        if (next > maxEntries) {
          idsToDelete.push(row.id);
        }
      }

      if (idsToDelete.length > 0) {
        const placeholders = idsToDelete.map(() => '?').join(', ');
        const result = this.db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...idsToDelete);
        deleted += result.changes;
      }
    }

    const retained = (this.db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number }).count;
    return { deleted, retained };
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        parent_span_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        template_id TEXT,
        envelope TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id);
      CREATE INDEX IF NOT EXISTS idx_observations_run_id ON observations(run_id);
      CREATE INDEX IF NOT EXISTS idx_observations_trace_id ON observations(trace_id);
      CREATE INDEX IF NOT EXISTS idx_observations_kind ON observations(kind);
      CREATE INDEX IF NOT EXISTS idx_observations_status ON observations(status);
      CREATE INDEX IF NOT EXISTS idx_observations_template_id ON observations(template_id);
      CREATE INDEX IF NOT EXISTS idx_observations_timestamp ON observations(timestamp);
    `);
  }

  private queryRows(opts?: PersistedObservationListOptions): SqliteObservationRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    const agentIds = this.resolveAgentIds(opts);
    if (agentIds.length > 0) {
      clauses.push(`agent_id IN (${agentIds.map(() => '?').join(', ')})`);
      params.push(...agentIds);
    }
    if (opts?.runId) {
      clauses.push('run_id = ?');
      params.push(opts.runId);
    }
    if (opts?.traceId) {
      clauses.push('trace_id = ?');
      params.push(opts.traceId);
    }
    if (opts?.parentSpanId) {
      clauses.push('parent_span_id = ?');
      params.push(opts.parentSpanId);
    }
    if (opts?.kinds?.length) {
      clauses.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`);
      params.push(...opts.kinds);
    }
    if (opts?.statuses?.length) {
      clauses.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`);
      params.push(...opts.statuses);
    }
    if (opts?.templateIds?.length) {
      clauses.push(`template_id IN (${opts.templateIds.map(() => '?').join(', ')})`);
      params.push(...opts.templateIds);
    }
    if (opts?.fromTimestamp !== undefined) {
      clauses.push('timestamp >= ?');
      params.push(opts.fromTimestamp);
    }
    if (opts?.toTimestamp !== undefined) {
      clauses.push('timestamp <= ?');
      params.push(opts.toTimestamp);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT id, agent_id, seq, timestamp, envelope
         FROM observations
         ${where}
         ORDER BY timestamp ASC, agent_id ASC, seq ASC, id ASC`
      )
      .all(...params) as SqliteObservationRow[];
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
