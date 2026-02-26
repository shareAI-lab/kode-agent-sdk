/**
 * Unified benchmark runner entry point.
 * Supports SWE-bench-Verified, Terminal Bench 2.0, or both.
 */

import '../helpers/env-setup';
import { parseCliArgs, loadConfig } from './config';
import { printProviderSummary, printSWETable, printTB2Summary, writeJsonReport } from './reporter';
import { loadReport, compareReports, printComparison } from './compare';
import type { BenchmarkReport } from './types';
import { run as runSWE } from './swe';
import { runTB2Official } from './run-tb2-official';

async function main(): Promise<void> {
  const cliArgs = parseCliArgs();
  const config = loadConfig(cliArgs);

  printProviderSummary(config);

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    sdk_version: config.sdkVersion,
  };

  if (config.benchmark === 'swe' || config.benchmark === 'both') {
    console.log('  Running module: swe ...');
    const sweResult = await runSWE(config);
    if (sweResult.swe) {
      report.swe = sweResult.swe;
      for (const r of sweResult.swe) {
        printSWETable(r.summary.dataset, r.summary.total, [r]);
      }
    }
  }

  if (config.benchmark === 'tb2' || config.benchmark === 'both') {
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

  if (!report.swe && !report.tb2) {
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
