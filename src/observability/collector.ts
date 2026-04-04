import { logger } from '../utils/logger';
import { buildObservationRunView, filterObservationEnvelopes, matchesObservationEnvelope } from './query';
import { NoopObservationSink } from './sinks/noop';
import {
  AgentMetricsSnapshot,
  GenerationObservation,
  ObservationEnvelope,
  ObservationKind,
  ObservationListOptions,
  ObservationReader,
  ObservationRecord,
  ObservationSink,
  ObservationSubscribeOptions,
  ObservationRunView,
} from './types';

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

export class ObservationCollector implements ObservationReader {
  private seq = 0;
  private readonly envelopes: ObservationEnvelope[] = [];
  private readonly subscribers = new Set<ObservationSubscriber>();
  private readonly sink: ObservationSink;
  private snapshot: AgentMetricsSnapshot;

  constructor(
    private readonly agentId: string,
    private readonly enabled = true,
    sink?: ObservationSink
  ) {
    this.sink = sink ?? new NoopObservationSink();
    this.snapshot = {
      agentId,
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

  record(observation: ObservationRecord): void {
    if (!this.enabled) return;

    const envelope: ObservationEnvelope = {
      seq: this.seq++,
      timestamp: Date.now(),
      observation,
    };

    this.envelopes.push(envelope);
    if (this.envelopes.length > 2000) {
      this.envelopes.splice(0, this.envelopes.length - 1000);
    }

    this.applyToSnapshot(observation);

    for (const subscriber of this.subscribers) {
      subscriber.push(envelope);
    }

    void Promise.resolve(this.sink.onObservation(envelope)).catch((error) => {
      logger.warn('[Observability] Sink failed:', error);
    });
  }

  subscribe(opts?: ObservationSubscribeOptions): AsyncIterable<ObservationEnvelope> {
    if (!this.enabled) {
      return {
        async *[Symbol.asyncIterator]() {
          return;
        },
      };
    }

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

  getMetricsSnapshot(): AgentMetricsSnapshot {
    return JSON.parse(JSON.stringify(this.snapshot));
  }

  listObservations(opts?: ObservationListOptions): ObservationEnvelope[] {
    if (!this.enabled) {
      return [];
    }

    return filterObservationEnvelopes(this.envelopes, opts);
  }

  getRun(runId: string): ObservationRunView | undefined {
    if (!this.enabled) {
      return undefined;
    }

    return buildObservationRunView(this.envelopes, runId);
  }

  list(opts?: { kinds?: ObservationKind[]; limit?: number }): ObservationRecord[] {
    return this.listObservations(opts).map((entry) => entry.observation);
  }

  private applyToSnapshot(observation: ObservationRecord): void {
    this.snapshot.currentRunId = observation.runId;
    this.snapshot.traceId = observation.traceId;

    if (observation.kind === 'generation') {
      this.applyGeneration(observation);
      return;
    }

    if (observation.kind === 'agent_run') {
      if (observation.trigger === 'scheduler') {
        this.snapshot.totals.scheduledRuns += 1;
      }
      return;
    }

    if (observation.kind === 'tool') {
      this.snapshot.totals.toolCalls += 1;
      if (observation.status === 'error') {
        this.snapshot.totals.toolErrors += 1;
      }
      if (observation.approval?.requestedAt !== undefined) {
        this.snapshot.totals.approvalRequests += 1;
      }
      if (observation.approval?.requestedAt !== undefined && observation.approval.status === 'denied') {
        this.snapshot.totals.approvalDenials += 1;
      }
      if (observation.approval?.waitMs !== undefined) {
        this.snapshot.totals.approvalWaitMsTotal += observation.approval.waitMs;
      }
      return;
    }

    if (observation.kind === 'subagent') {
      this.snapshot.totals.subagents += 1;
      return;
    }

    if (observation.kind === 'compression') {
      this.snapshot.totals.compressions += 1;
      if (observation.status === 'error') {
        this.snapshot.totals.compressionErrors += 1;
      }
      if (
        observation.estimatedTokensBefore !== undefined &&
        observation.estimatedTokensAfter !== undefined &&
        observation.estimatedTokensBefore > observation.estimatedTokensAfter
      ) {
        this.snapshot.totals.tokensSavedEstimate +=
          observation.estimatedTokensBefore - observation.estimatedTokensAfter;
      }
    }
  }

  private applyGeneration(observation: GenerationObservation): void {
    this.snapshot.totals.generations += 1;
    if (observation.status === 'error') {
      this.snapshot.totals.generationErrors += 1;
    }

    const usage = observation.usage;
    if (usage) {
      this.snapshot.totals.inputTokens += usage.inputTokens;
      this.snapshot.totals.outputTokens += usage.outputTokens;
      this.snapshot.totals.totalTokens += usage.totalTokens;
      this.snapshot.totals.reasoningTokens += usage.reasoningTokens ?? 0;
    }

    const totalCost = observation.cost?.totalCost ?? 0;
    this.snapshot.totals.totalCostUsd += totalCost;

    this.snapshot.lastGeneration = {
      provider: observation.provider,
      model: observation.model,
      requestId: observation.requestId,
      latencyMs: observation.request?.latencyMs,
      timeToFirstTokenMs: observation.request?.timeToFirstTokenMs,
      stopReason: observation.request?.stopReason,
      retryCount: observation.request?.retryCount,
      totalTokens: observation.usage?.totalTokens,
      totalCostUsd: totalCost,
    };
  }
}
