import { logger } from '../../utils/logger';
import type { ObservationEnvelope, ObservationSink } from '../types';
import type { ObservationQueryBackend, ObservationRetentionPolicy } from './types';

export class PersistedObservationSink implements ObservationSink {
  private readonly pruneIntervalMs: number;
  private lastPruneAt = 0;
  private prunePromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly backend: ObservationQueryBackend,
    private readonly opts?: {
      retention?: ObservationRetentionPolicy;
      pruneIntervalMs?: number;
    }
  ) {
    this.pruneIntervalMs = Math.max(1_000, opts?.pruneIntervalMs ?? 60_000);
  }

  async onObservation(envelope: ObservationEnvelope): Promise<void> {
    try {
      await this.backend.append(envelope);
    } catch (error) {
      logger.warn('[Observability] Persisted sink append failed:', error);
      return;
    }

    await this.maybePrune();
  }

  async shutdown(): Promise<void> {
    await this.prunePromise.catch(() => undefined);
    await this.backend.close?.();
  }

  private async maybePrune(): Promise<void> {
    if (!this.opts?.retention || !this.backend.prune) {
      return;
    }

    const now = Date.now();
    if (now - this.lastPruneAt < this.pruneIntervalMs) {
      return;
    }

    this.lastPruneAt = now;
    this.prunePromise = this.prunePromise
      .then(async () => {
        await this.backend.prune?.(this.opts?.retention);
      })
      .catch((error) => {
        logger.warn('[Observability] Persisted sink prune failed:', error);
      });

    await this.prunePromise;
  }
}
