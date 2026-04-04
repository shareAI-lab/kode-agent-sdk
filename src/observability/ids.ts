function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function generateRunId(): string {
  return createId('run');
}

export function generateTraceId(): string {
  return createId('trc');
}

export function generateSpanId(): string {
  return createId('spn');
}
