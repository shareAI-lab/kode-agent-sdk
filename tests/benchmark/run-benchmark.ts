/**
 * Unified benchmark runner entry point.
 * Supports SWE-bench-Verified, TAU-bench, Terminal Bench 2.0, or combinations.
 */

import '../helpers/env-setup';
import { parseCliArgs, loadConfig } from './config';
import { printProviderSummary, printSWETable, printTAUTable, printTB2Summary, writeJsonReport } from './reporter';
import { loadReport, compareReports, printComparison } from './compare';
import type { BenchmarkReport } from './types';
import { run as runSWE } from './swe';
import { run as runTAU } from './tau';
import { runTB2Official } from './run-tb2-official';

async function main(): Promise<void> {
  const cliArgs = parseCliArgs();
  const config = loadConfig(cliArgs);

  printProviderSummary(config);

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    sdk_version: config.sdkVersion,
  };

  const runSWEFlag = config.benchmark === 'swe' || config.benchmark === 'both' || config.benchmark === 'all';
  const runTAUFlag = config.benchmark === 'tau' || config.benchmark === 'both' || config.benchmark === 'all';
  const runTB2Flag = config.benchmark === 'tb2' || config.benchmark === 'both' || config.benchmark === 'all';

  if (runSWEFlag) {
    console.log('  Running module: swe ...');
    const sweResult = await runSWE(config);
    if (sweResult.swe) {
      report.swe = sweResult.swe;
      for (const r of sweResult.swe) {
        printSWETable(r.summary.dataset, r.summary.total, [r]);
      }
    }
  }

  if (runTAUFlag) {
    console.log('  Running module: tau ...');
    const tauResult = await runTAU(config);
    if (tauResult.tau) {
      report.tau = tauResult.tau;
      for (const r of tauResult.tau) {
        printTAUTable(r.summary.domain, r.summary.total_tasks, r.summary.num_trials, [r]);
      }
    }
  }

  if (runTB2Flag) {
    console.log('  Running module: tb2 ...');
    const tb2 = runTB2Official({
      dataset: config.tb2Dataset,
      model: config.tb2Model,
      agent: config.tb2Agent,
      jobsDir: config.tb2JobsDir,
      runner: config.tb2Runner,
      dockerImage: config.tb2DockerImage,
      python: config.tb2Python,
      envFile: config.tb2EnvFile,
    });
    report.tb2 = tb2;
    printTB2Summary(tb2);
  }

  if (!report.swe && !report.tau && !report.tb2) {
    console.error('  No benchmark results produced. Check prerequisites and benchmark settings.');
    process.exitCode = 1;
    return;
  }

  if (config.output === 'json') {
    writeJsonReport(report, config.outputFile);
  }

  if (cliArgs.compare) {
    try {
      const baselineReport = loadReport(cliArgs.compare);
      const comparison = compareReports(baselineReport, report);
      printComparison(cliArgs.compare, '(current run)', comparison);

      if (comparison.hasRegressions) {
        process.exitCode = 1;
      }
    } catch (err: any) {
      console.error(`  Failed to load baseline report "${cliArgs.compare}": ${err.message}`);
    }
  }
}

main().catch(err => {
  console.error('Benchmark runner error:', err);
  process.exitCode = 1;
});
