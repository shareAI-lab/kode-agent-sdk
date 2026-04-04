import { logger } from '../../utils/logger';
import type { ObservationEnvelope, ObservationSink } from '../types';
import { OTLPHttpJsonExporter } from './exporter';
import { applyOTelPolicies } from './policy';
import { createOTelSpanTranslator } from './translator';
import type { OTelBridgeConfig, OTelSpanData, OTelSpanExporter } from './types';

export class OTelObservationSink implements ObservationSink {
  private readonly translator;
  private readonly exporter?: OTelSpanExporter;
  private readonly exportMode;
  private readonly batchSize;
  private readonly flushIntervalMs;
  private readonly queue: OTelSpanData[] = [];
  private flushTimer?: NodeJS.Timeout;
  private pendingFlush: Promise<void> = Promise.resolve();

  constructor(private readonly config: OTelBridgeConfig = {}) {
    this.translator = createOTelSpanTranslator(config);
    this.exporter = createOTelExporter(config);
    this.exportMode = config.exportMode ?? 'immediate';
    this.batchSize = Math.max(1, config.batchSize ?? 50);
    this.flushIntervalMs = Math.max(10, config.flushIntervalMs ?? 1000);
  }

  async onObservation(envelope: ObservationEnvelope): Promise<void> {
    if (this.config.enabled === false || !this.exporter) {
      return;
    }

    try {
      const translated = this.translator(envelope);
      const span = applyOTelPolicies(envelope, translated, this.config);
      if (!span) {
        return;
      }

      if (this.exportMode === 'immediate') {
        await this.exporter.export([span]);
        return;
      }

      this.queue.push(span);
      if (this.queue.length >= this.batchSize) {
        await this.forceFlush();
        return;
      }

      this.ensureFlushTimer();
    } catch (error) {
      logger.warn('[Observability] OTel bridge failed:', error);
    }
  }

  async forceFlush(): Promise<void> {
    if (!this.exporter) {
      return;
    }

    const spans = this.queue.splice(0, this.queue.length);
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    this.pendingFlush = this.pendingFlush.then(async () => {
      if (spans.length > 0) {
        await this.exporter!.export(spans);
      }
      await this.exporter!.forceFlush?.();
    }).catch((error) => {
      logger.warn('[Observability] OTel bridge flush failed:', error);
    });

    await this.pendingFlush;
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.forceFlush();
    await this.exporter?.shutdown?.();
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.forceFlush();
    }, this.flushIntervalMs);
  }
}

export function createOTelExporter(config: OTelBridgeConfig): OTelSpanExporter | undefined {
  if (config.exporter) {
    return config.exporter;
  }
  if (config.endpoint) {
    return new OTLPHttpJsonExporter({
      endpoint: config.endpoint,
      headers: config.headers,
      serviceName: config.serviceName,
      fetch: config.fetch,
    });
  }
  return undefined;
}
