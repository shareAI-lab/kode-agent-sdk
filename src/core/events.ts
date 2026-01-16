import { EventEmitter } from 'events';
import {
  AgentChannel,
  AgentEvent,
  AgentEventEnvelope,
  ControlEvent,
  MonitorEvent,
  ProgressEvent,
  Timeline,
  Bookmark,
} from '../core/types';
import { Store } from '../infra/store';
import { logger } from '../utils/logger';

type ControlEventType = ControlEvent['type'];
type MonitorEventType = MonitorEvent['type'];

type SubscriberChannel = 'progress' | 'control' | 'monitor';

export class EventBus {
  private cursor = 0;
  private seq = 0;
  private timeline: Timeline[] = [];
  private subscribers = new Map<SubscriberChannel, Set<EventSubscriber<any>>>();
  private controlEmitter = new EventEmitter();
  private monitorEmitter = new EventEmitter();
  private store?: Store;
  private agentId?: string;
  private failedEvents: Timeline[] = [];
  private readonly MAX_FAILED_BUFFER = 1000;

  constructor() {
    this.subscribers.set('progress', new Set());
    this.subscribers.set('control', new Set());
    this.subscribers.set('monitor', new Set());
  }

  setStore(store: Store, agentId: string) {
    this.store = store;
    this.agentId = agentId;
  }

  emitProgress(event: ProgressEvent): AgentEventEnvelope<ProgressEvent> {
    const envelope = this.emit('progress', event) as AgentEventEnvelope<ProgressEvent>;
    this.notifySubscribers('progress', envelope);
    return envelope;
  }

  emitControl(event: ControlEvent): AgentEventEnvelope<ControlEvent> {
    const envelope = this.emit('control', event) as AgentEventEnvelope<ControlEvent>;
    this.controlEmitter.emit(event.type, envelope.event);
    this.notifySubscribers('control', envelope);
    return envelope;
  }

  emitMonitor(event: MonitorEvent): AgentEventEnvelope<MonitorEvent> {
    const envelope = this.emit('monitor', event) as AgentEventEnvelope<MonitorEvent>;
    this.monitorEmitter.emit(event.type, envelope.event);
    this.notifySubscribers('monitor', envelope);
    return envelope;
  }

  subscribeProgress(opts?: {
    since?: Bookmark;
    kinds?: Array<ProgressEvent['type']>;
  }): AsyncIterable<AgentEventEnvelope<ProgressEvent>> {
    const subscriber = new EventSubscriber<ProgressEvent>(opts?.kinds);
    this.subscribers.get('progress')!.add(subscriber);

    if (opts?.since) {
      void this.replayHistory('progress', subscriber, opts.since);
    }

    const bus = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEventEnvelope<ProgressEvent>> {
        return {
          async next() {
            const value = (await subscriber.next()) as AgentEventEnvelope<ProgressEvent> | null;
            if (!value) {
              bus.subscribers.get('progress')!.delete(subscriber);
              return { done: true, value: undefined as any };
            }
            return { done: false, value };
          },
          async return() {
            subscriber.close();
            bus.subscribers.get('progress')!.delete(subscriber);
            return { done: true, value: undefined as any };
          },
        };
      },
    };
  }

  subscribe(
    channels: SubscriberChannel[] = ['progress', 'control', 'monitor'],
    opts?: { since?: Bookmark; kinds?: Array<AgentEvent['type']> }
  ): AsyncIterable<AgentEventEnvelope> {
    const subscriber = new EventSubscriber<AgentEvent>(opts?.kinds);
    for (const channel of channels) {
      this.subscribers.get(channel)!.add(subscriber);
      if (opts?.since) {
        void this.replayHistory(channel, subscriber, opts.since);
      }
    }
    return this.iterableFor(channels, subscriber);
  }

  onControl<T extends ControlEventType>(
    type: T,
    handler: (evt: Extract<ControlEvent, { type: T }>) => void
  ): () => void {
    this.controlEmitter.on(type, handler);
    return () => this.controlEmitter.off(type, handler);
  }

  onMonitor<T extends MonitorEventType>(
    type: T,
    handler: (evt: Extract<MonitorEvent, { type: T }>) => void
  ): () => void {
    this.monitorEmitter.on(type, handler);
    return () => this.monitorEmitter.off(type, handler);
  }

  getTimeline(since?: number): Timeline[] {
    return since !== undefined ? this.timeline.filter((t) => t.cursor >= since) : this.timeline;
  }

  getCursor(): number {
    return this.cursor;
  }

  getLastBookmark(): Bookmark | undefined {
    const last = this.timeline[this.timeline.length - 1];
    return last?.bookmark;
  }

  syncCursor(bookmark?: Bookmark): void {
    if (!bookmark) return;
    const nextSeq = bookmark.seq + 1;
    if (this.seq < nextSeq) {
      this.seq = nextSeq;
    }
    const timelineCursor = this.timeline.length
      ? this.timeline[this.timeline.length - 1].cursor + 1
      : 0;
    const nextCursor = Math.max(this.cursor, nextSeq, timelineCursor);
    if (this.cursor < nextCursor) {
      this.cursor = nextCursor;
    }
  }

  reset() {
    this.cursor = 0;
    this.seq = 0;
    this.timeline = [];
    for (const set of this.subscribers.values()) {
      set.clear();
    }
    this.controlEmitter.removeAllListeners();
    this.monitorEmitter.removeAllListeners();
  }

  private emit(channel: AgentChannel, event: AgentEvent): AgentEventEnvelope {
    const bookmark: Bookmark = {
      seq: this.seq++,
      timestamp: Date.now(),
    };

    const eventWithChannel = { ...event, channel } as AgentEvent;
    const eventWithBookmark = { ...(eventWithChannel as any), bookmark } as AgentEvent;

    const envelope: AgentEventEnvelope = {
      cursor: this.cursor++,
      bookmark,
      event: eventWithBookmark,
    };

    const timelineEntry: Timeline = {
      cursor: envelope.cursor,
      bookmark,
      event: envelope.event,
    };

    this.timeline.push(timelineEntry);
    if (this.timeline.length > 10000) {
      this.timeline = this.timeline.slice(-5000);
    }

    if (this.store && this.agentId) {
      const isCritical = this.isCriticalEvent(event);

      this.store.appendEvent(this.agentId, timelineEntry)
        .then(() => {
          // 成功后尝试重试之前失败的事件
          if (this.failedEvents.length > 0) {
            void this.retryFailedEvents();
          }
        })
        .catch((err) => {
          if (isCritical) {
            // 关键事件失败：缓存到内存
            this.failedEvents.push(timelineEntry);
            if (this.failedEvents.length > this.MAX_FAILED_BUFFER) {
              this.failedEvents = this.failedEvents.slice(-this.MAX_FAILED_BUFFER);
            }

            // 发送降级的内存 Monitor 事件（不持久化）
            try {
              this.monitorEmitter.emit('storage_failure', {
                type: 'storage_failure',
                severity: 'critical',
                failedEvent: event.type,
                bufferedCount: this.failedEvents.length,
                error: err.message
              });
            } catch {
              // 降级事件发送失败也不阻塞
            }
          } else {
            // 非关键事件失败：仅记录日志
            logger.warn(`[EventBus] Failed to persist non-critical event: ${event.type}`, err);
          }
        });
    }

    return envelope;
  }

  private isCriticalEvent(event: AgentEvent): boolean {
    const criticalTypes = new Set([
      'tool:end',
      'done',
      'permission_decided',
      'agent_resumed',
      'state_changed',
      'breakpoint_changed',
      'error',
    ]);
    return criticalTypes.has(event.type);
  }

  private async retryFailedEvents(): Promise<void> {
    if (!this.store || !this.agentId || this.failedEvents.length === 0) return;

    const toRetry = this.failedEvents.splice(0, 10);
    for (const event of toRetry) {
      try {
        await this.store.appendEvent(this.agentId, event);
      } catch (err) {
        this.failedEvents.unshift(event);
        break;
      }
    }
  }

  getFailedEventCount(): number {
    return this.failedEvents.length;
  }

  async flushFailedEvents(): Promise<void> {
    while (this.failedEvents.length > 0) {
      await this.retryFailedEvents();
      if (this.failedEvents.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private notifySubscribers(channel: SubscriberChannel, envelope: AgentEventEnvelope) {
    const subscribers = this.subscribers.get(channel);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      if (subscriber.accepts(envelope)) {
        subscriber.push(envelope);
      }
    }
  }

  private async replayHistory<T extends AgentEvent>(
    channel: SubscriberChannel,
    subscriber: EventSubscriber<T>,
    since?: Bookmark
  ): Promise<void> {
    if (this.store && this.agentId) {
      try {
        const opts = { channel: channel as AgentChannel, since };
        for await (const entry of this.store.readEvents(this.agentId, opts)) {
          const envelope = entry as AgentEventEnvelope<T>;
          if (subscriber.accepts(envelope)) {
            subscriber.push(envelope);
          }
        }
        return;
      } catch (error) {
        logger.error('Failed to replay events from store:', error);
      }
    }

    const past = this.timeline.filter((t) => {
      if (t.event.channel !== channel) return false;
      if (!since) return true;
      return t.bookmark.seq > since.seq;
    });
    for (const entry of past) {
      const envelope = entry as AgentEventEnvelope<T>;
      if (subscriber.accepts(envelope)) {
        subscriber.push(envelope);
      }
    }
  }

  private iterableFor<T extends AgentEvent>(
    channel: SubscriberChannel | SubscriberChannel[],
    subscriber: EventSubscriber<T | AgentEvent>
  ): AsyncIterable<AgentEventEnvelope<T>> {
    const channels = Array.isArray(channel) ? channel : [channel];
    const bus = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentEventEnvelope<T>> {
        return {
          next: async () => {
            const value = (await subscriber.next()) as AgentEventEnvelope<T> | null;
            if (!value) {
              for (const ch of channels) bus.subscribers.get(ch)!.delete(subscriber);
              return { done: true, value: undefined as any };
            }
            return { done: false, value };
          },
          return: async () => {
            subscriber.close();
            for (const ch of channels) bus.subscribers.get(ch)!.delete(subscriber);
            return { done: true, value: undefined as any };
          },
        };
      },
    };
  }
}

class EventSubscriber<T extends AgentEvent> {
  private queue: AgentEventEnvelope<T>[] = [];
  private waiting: ((event: AgentEventEnvelope<T> | null) => void) | null = null;
  private closed = false;

  constructor(private kinds?: string[]) {}

  accepts(envelope: AgentEventEnvelope<T>): boolean {
    if (!this.kinds || this.kinds.length === 0) return true;
    return this.kinds.includes(String(envelope.event.type));
  }

  push(envelope: AgentEventEnvelope<T>) {
    if (this.closed) return;
    if (this.waiting) {
      this.waiting(envelope);
      this.waiting = null;
    } else {
      this.queue.push(envelope);
    }
  }

  async next(): Promise<AgentEventEnvelope<T> | null> {
    if (this.closed) return null;
    if (this.queue.length > 0) return this.queue.shift()!;

    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  close() {
    this.closed = true;
    if (this.waiting) {
      this.waiting(null);
      this.waiting = null;
    }
  }
}
