import type {
  ObservationEnvelope,
  ObservationListOptions,
  ObservationRunView,
} from '../types';

export interface PersistedObservationListOptions extends ObservationListOptions {
  agentIds?: string[];
  templateIds?: string[];
  fromTimestamp?: number;
  toTimestamp?: number;
}

export interface ObservationRetentionPolicy {
  maxEntriesPerAgent?: number;
  maxAgeMs?: number;
}

export interface ObservationPruneResult {
  deleted: number;
  retained: number;
}

export interface ObservationQueryBackend {
  append(envelope: ObservationEnvelope): Promise<void>;
  list(opts?: PersistedObservationListOptions): Promise<ObservationEnvelope[]>;
  getRun(runId: string): Promise<ObservationRunView | undefined>;
  prune?(opts?: ObservationRetentionPolicy): Promise<ObservationPruneResult>;
  close?(): Promise<void>;
}

export interface PersistedObservationReader {
  listObservations(opts?: PersistedObservationListOptions): Promise<ObservationEnvelope[]>;
  getRun(runId: string): Promise<ObservationRunView | undefined>;
}

export interface ObservationPersistenceConfig {
  enabled?: boolean;
  backend?: ObservationQueryBackend;
  retention?: ObservationRetentionPolicy;
  pruneIntervalMs?: number;
}
