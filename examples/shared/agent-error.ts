import type { Agent } from '../../src';

export function createErrorTracker(
  agent: Agent,
  options?: { log?: boolean }
): {
  beginCall: () => number;
  finishCall: (token: number) => string | null;
  dispose: () => void;
} {
  let callSeq = 0;
  let activeToken = 0;
  let lastErrorToken = 0;
  let lastErrorMessage = '';
  const logErrors = options?.log !== false;

  const unsubscribe = agent.on('error', (evt) => {
    const detail = evt.detail?.error || evt.message;
    if (logErrors) {
      process.stderr.write(`\n[monitor:error] ${evt.phase} ${detail}\n`);
    }
    if (evt.phase === 'model' && activeToken > 0) {
      lastErrorToken = activeToken;
      lastErrorMessage = String(detail ?? '');
    }
  });

  const beginCall = () => {
    lastErrorToken = 0;
    lastErrorMessage = '';
    activeToken = ++callSeq;
    return activeToken;
  };

  const finishCall = (token: number) => {
    activeToken = 0;
    if (lastErrorToken === token) {
      return lastErrorMessage || 'Model call failed.';
    }
    return null;
  };

  const dispose = () => {
    unsubscribe();
  };

  return { beginCall, finishCall, dispose };
}
