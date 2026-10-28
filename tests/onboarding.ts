import { run as publicOnboarding } from './unit/core/onboarding.test';
import { run as lifecycle } from './unit/core/agent-lifecycle.test';
import { run as acceptance } from './unit/core/agent-acceptance.test';
import { run as boundary } from './unit/infra/sandbox-boundary.test';

globalThis.fetch = (async () => { throw new Error('Live fetch is disabled in onboarding tests'); }) as typeof fetch;

(async () => {
  for (const run of [publicOnboarding, lifecycle, acceptance, boundary]) {
    const result = await run();
    console.log(result.output);
    if (result.failed) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
