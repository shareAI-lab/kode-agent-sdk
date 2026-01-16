import { Agent } from '../../src';
import { ControlEvent, MonitorEvent, ProgressEvent } from '../../src/core/types';
import { expect } from './utils';

export interface ChatEventsResult {
  reply: Awaited<ReturnType<Agent['chat']>>;
  progress: ProgressEvent[];
  control: ControlEvent[];
  monitor: MonitorEvent[];
}

export async function runChatWithEvents(
  agent: Agent,
  prompt: string,
  opts?: { onPermission?: (event: Extract<ControlEvent, { type: 'permission_required' }>) => Promise<void> | void }
): Promise<ChatEventsResult> {
  const progress: ProgressEvent[] = [];
  const control: ControlEvent[] = [];
  const monitor: MonitorEvent[] = [];

  const iterator = agent.subscribe(['progress', 'control', 'monitor'])[Symbol.asyncIterator]();
  const pending = agent.chat(prompt);
  let reply: Awaited<ReturnType<Agent['chat']>> | undefined;

  while (true) {
    const { value, done } = await iterator.next();
    if (!value && done) break;
    if (!value) continue;

    const event = value.event as ProgressEvent | ControlEvent | MonitorEvent;
    if (event.channel === 'progress') {
      progress.push(event as ProgressEvent);
      if (event.type === 'done') {
        reply = await pending;
        break;
      }
    } else if (event.channel === 'control') {
      control.push(event as ControlEvent);
      if (event.type === 'permission_required' && opts?.onPermission) {
        await opts.onPermission(event as Extract<ControlEvent, { type: 'permission_required' }>);
      }
    } else if (event.channel === 'monitor') {
      monitor.push(event as MonitorEvent);
    }
  }

  if (iterator.return) {
    await iterator.return();
  }

  if (!reply) {
    reply = await pending;
  }

  return { reply, progress, control, monitor };
}

function assertContainsOnly(types: string[], allowed: string[], label: string) {
  for (const type of types) {
    expect.toBeTruthy(allowed.includes(type), `[${label}] Unexpected progress event: ${type}`);
  }
}

function assertOrder(types: string[], expected: string[], label: string) {
  let index = -1;
  for (const type of expected) {
    const next = types.indexOf(type, index + 1);
    expect.toBeGreaterThan(next, -1, `[${label}] Missing event: ${type}`);
    index = next;
  }
}

export function assertTextStream(progress: ProgressEvent[], label: string) {
  const types = progress.map((event) => event.type);
  assertContainsOnly(types, ['text_chunk_start', 'text_chunk', 'text_chunk_end', 'done'], label);
  assertOrder(types, ['text_chunk_start', 'text_chunk', 'text_chunk_end', 'done'], label);
}

export function assertHasText(progress: ProgressEvent[], label: string) {
  const hasText = progress.some((event) => event.type === 'text_chunk');
  expect.toBeTruthy(hasText, `[${label}] Missing text_chunk`);
}

export function assertToolSuccessFlow(progress: ProgressEvent[], label: string) {
  const types = progress.map((event) => event.type);
  assertContainsOnly(
    types,
    ['tool:start', 'tool:end', 'text_chunk_start', 'text_chunk', 'text_chunk_end', 'done'],
    label
  );
  expect.toBeFalsy(types.includes('tool:error'), `[${label}] Unexpected tool:error`);
  assertOrder(types, ['tool:start', 'tool:end', 'text_chunk_start', 'text_chunk', 'text_chunk_end', 'done'], label);
}

export function assertToolFailureFlow(progress: ProgressEvent[], label: string) {
  const types = progress.map((event) => event.type);
  assertContainsOnly(
    types,
    ['tool:start', 'tool:error', 'tool:end', 'text_chunk_start', 'text_chunk', 'text_chunk_end', 'done'],
    label
  );
  assertOrder(types, ['tool:start', 'tool:error', 'tool:end', 'text_chunk_start', 'text_chunk', 'text_chunk_end', 'done'], label);
}

export function assertPermissionRequired(control: ControlEvent[], label: string) {
  const hasPermission = control.some((event) => event.type === 'permission_required');
  expect.toBeTruthy(hasPermission, `[${label}] Missing permission_required`);
}

export function assertPermissionDecided(
  control: ControlEvent[],
  decision: 'allow' | 'deny',
  label: string
) {
  const hasDecision = control.some(
    (event) => event.type === 'permission_decided' && event.decision === decision
  );
  expect.toBeTruthy(hasDecision, `[${label}] Missing permission_decided(${decision})`);
}

export function assertToolDeniedFlow(progress: ProgressEvent[], label: string) {
  const types = progress.map((event) => event.type);
  assertContainsOnly(
    types,
    ['tool:start', 'tool:end', 'text_chunk_start', 'text_chunk', 'text_chunk_end', 'done'],
    label
  );
  expect.toBeFalsy(types.includes('tool:error'), `[${label}] Unexpected tool:error`);
  assertOrder(types, ['tool:start', 'tool:end', 'text_chunk_start', 'text_chunk', 'text_chunk_end', 'done'], label);
}
