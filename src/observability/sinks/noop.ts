import { ObservationEnvelope, ObservationSink } from '../types';

export class NoopObservationSink implements ObservationSink {
  onObservation(_envelope: ObservationEnvelope): void {
    // Intentionally empty.
  }
}
