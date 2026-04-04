import { logger } from '../../utils/logger';
import { ObservationEnvelope, ObservationSink } from '../types';

export class CompositeObservationSink implements ObservationSink {
  constructor(private readonly sinks: ObservationSink[]) {}

  async onObservation(envelope: ObservationEnvelope): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.onObservation(envelope);
      } catch (error) {
        logger.warn('[Observability] Composite sink target failed:', error);
      }
    }
  }
}
