import { ToolRunner } from '../../../src/core/agent/tool-runner';
import { TestRunner, expect } from '../../helpers/utils';

const runner = new TestRunner('ToolRunner');

runner
  .test('尊重并发限制与队列', async () => {
    const runnerInstance = new ToolRunner(2);
    let peakConcurrency = 0;
    let currentConcurrency = 0;

    const tasks = Array.from({ length: 5 }, (_, index) =>
      runnerInstance.run(async () => {
        currentConcurrency += 1;
        if (currentConcurrency > peakConcurrency) {
          peakConcurrency = currentConcurrency;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentConcurrency -= 1;
        return index;
      })
    );

    const results = await Promise.all(tasks);
    expect.toHaveLength(results, 5);
    expect.toEqual(peakConcurrency <= 2, true);
  })

  .test('clear会丢弃等待队列', async () => {
    const runnerInstance = new ToolRunner(1);
    const results: number[] = [];

    const first = runnerInstance.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 1;
    });

    let executed = false;
    const second = runnerInstance
      .run(async () => {
        executed = true;
        results.push(2);
        return 2;
      })
      .catch(() => {});

    runnerInstance.clear();

    expect.toEqual(await first, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect.toEqual(executed, false);
    expect.toHaveLength(results, 0);
    const outcome = await Promise.race([
      second.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);
    expect.toEqual(outcome, 'timeout');
  })

  .test('任务失败不会阻塞队列并保持后续执行', async () => {
    const runnerInstance = new ToolRunner(2);
    const timeline: string[] = [];

    const makeTask = (label: string, delay: number, shouldFail = false) =>
      runnerInstance.run(async () => {
        timeline.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        timeline.push(`${label}:${shouldFail ? 'error' : 'end'}`);
        if (shouldFail) {
          throw new Error(`${label}-failed`);
        }
        return label;
      });

    const tasks = [
      makeTask('A', 50),
      makeTask('B', 5, true),
      makeTask('C', 5),
      makeTask('D', 5),
    ];

    const settled = await Promise.all(
      tasks.map((task) =>
        task.then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (error) => ({ status: 'rejected' as const, reason: error.message })
        )
      )
    );

    const successes = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    const failures = settled.filter((item) => item.status === 'rejected').map((item) => item.reason);

    expect.toEqual(successes.includes('A'), true);
    expect.toEqual(successes.includes('C'), true);
    expect.toEqual(successes.includes('D'), true);
    expect.toEqual(failures.includes('B-failed'), true);

    const endMarkers = timeline.filter((entry) => entry.endsWith('end'));
    expect.toBeGreaterThanOrEqual(endMarkers.length, 3);
    expect.toEqual(timeline.includes('B:error'), true);
    expect.toEqual(timeline.includes('C:start'), true);
    expect.toEqual(timeline.includes('D:start'), true);
    expect.toEqual(timeline.indexOf('C:start') > timeline.indexOf('B:error'), true);
    expect.toEqual(timeline.indexOf('D:start') > timeline.indexOf('C:end'), true);
  });

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
