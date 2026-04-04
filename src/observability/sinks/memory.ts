import { buildObservationRunView, filterObservationEnvelopes, matchesObservationEnvelope } from '../query';
import {
  ObservationEnvelope,
  ObservationListOptions,
  ObservationReader,
  ObservationRunView,
  ObservationSink,
  ObservationSubscribeOptions,
} from '../types';

class ObservationSubscriber {
  private readonly queue: ObservationEnvelope[] = [];
  private resolver?: (value: ObservationEnvelope | null) => void;
  private closed = false;

  constructor(private readonly opts?: ObservationSubscribeOptions) {}

  push(envelope: ObservationEnvelope): void {
    if (this.closed) return;
    if (!matchesObservationEnvelope(envelope, this.opts)) return;
    if (this.resolver) {
      const resolve = this.resolver;
      this.resolver = undefined;
      resolve(envelope);
      return;
    }
    this.queue.push(envelope);
  }

  next(): Promise<ObservationEnvelope | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift() || null);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  close(): void {
    this.closed = true;
    if (this.resolver) {
      const resolve = this.resolver;
      this.resolver = undefined;
      resolve(null);
    }
  }
}

export interface MemoryObservationStoreOptions {
  maxEntries?: number;
}

export class MemoryObservationStore implements ObservationSink, ObservationReader {
  private seq = 0;
  private readonly envelopes: ObservationEnvelope[] = [];
  private readonly subscribers = new Set<ObservationSubscriber>();
  private readonly maxEntries: number;

  constructor(opts?: MemoryObservationStoreOptions) {
    this.maxEntries = Math.max(1, opts?.maxEntries ?? 2000);
  }

  onObservation(envelope: ObservationEnvelope): void {
    const stored: ObservationEnvelope = {
      seq: this.seq++,
      timestamp: envelope.timestamp,
      observation: envelope.observation,
    };

    this.envelopes.push(stored);
    if (this.envelopes.length > this.maxEntries) {
      this.envelopes.splice(0, this.envelopes.length - this.maxEntries);
    }

    for (const subscriber of this.subscribers) {
      subscriber.push(stored);
    }
  }

  subscribe(opts?: ObservationSubscribeOptions): AsyncIterable<ObservationEnvelope> {
    const subscriber = new ObservationSubscriber(opts);
    this.subscribers.add(subscriber);

    for (const envelope of this.envelopes) {
      subscriber.push(envelope);
    }

    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<ObservationEnvelope> {
        return {
          async next() {
            const value = await subscriber.next();
            if (!value) {
              self.subscribers.delete(subscriber);
              return { done: true, value: undefined as any };
            }
            return { done: false, value };
          },
          async return() {
            subscriber.close();
            self.subscribers.delete(subscriber);
            return { done: true, value: undefined as any };
          },
        };
      },
    };
  }

  getMetricsSnapshot() {
    return {
      agentId: 'memory-observation-store',
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        totalCostUsd: 0,
        toolCalls: 0,
        toolErrors: 0,
        approvalRequests: 0,
        approvalDenials: 0,
        approvalWaitMsTotal: 0,
        compressions: 0,
        compressionErrors: 0,
        tokensSavedEstimate: 0,
        scheduledRuns: 0,
        generations: 0,
        generationErrors: 0,
        subagents: 0,
      },
    };
  }

  listObservations(opts?: ObservationListOptions): ObservationEnvelope[] {
    return filterObservationEnvelopes(this.envelopes, opts);
  }

  getRun(runId: string): ObservationRunView | undefined {
    return buildObservationRunView(this.envelopes, runId);
  }

  list(): ObservationEnvelope[] {
    return this.listObservations();
  }
}

export class MemoryObservationSink extends MemoryObservationStore {}
