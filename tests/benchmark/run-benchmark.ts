/**
 * Benchmark runner entry point
 */

import '../helpers/env-setup';
import { parseCliArgs, loadConfig } from './config';
import {
  printProviderSummary,
  printSWETable,
  printTAUTable,
  writeJsonReport,
  printNoBenchmarks,
} from './reporter';
import { writeHtmlReport } from './html-reporter';
import { loadReport, compareReports, printComparison } from './compare';
import type { BenchmarkCliArgs, BenchmarkConfig, BenchmarkModule, BenchmarkModuleResult, BenchmarkReport } from './types';

// ---------------------------------------------------------------------------
// Module discovery
// ---------------------------------------------------------------------------

async function tryLoadModule(path: string): Promise<BenchmarkModule | null> {
  try {
    const mod = await import(path);
    if (mod && typeof mod.run === 'function' && typeof mod.name === 'string') {
      return mod as BenchmarkModule;
    }
    if (mod && mod.default && typeof mod.default.run === 'function') {
      return mod.default as BenchmarkModule;
    }
    return null;
  } catch {
    return null;
  }
}

async function discoverModules(cliArgs: BenchmarkCliArgs): Promise<BenchmarkModule[]> {
  const modules: BenchmarkModule[] = [];

  if (!cliArgs.tauOnly) {
    const swe = await tryLoadModule('./swe/index');
    if (swe) modules.push(swe);
  }

  if (!cliArgs.sweOnly) {
    const tau = await tryLoadModule('./tau/index');
    if (tau) modules.push(tau);
  }

  return modules;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cliArgs = parseCliArgs();
  const config = loadConfig(cliArgs);

  printProviderSummary(config);

  const modules = await discoverModules(cliArgs);

  if (modules.length === 0) {
    printNoBenchmarks();
    return;
  }

  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    sdk_version: config.sdkVersion,
  };

  for (const mod of modules) {
    console.log(`  Running module: ${mod.name} ...`);
    const result: BenchmarkModuleResult = await mod.run(config);

    if (result.swe) {
      report.swe = result.swe;
      for (const r of result.swe) {
        printSWETable(r.summary.dataset, r.summary.total, [r]);
      }
    }

    if (result.tau) {
      report.tau = result.tau;
      for (const r of result.tau) {
        printTAUTable(r.summary.domain, r.summary.total_tasks, r.summary.num_trials, [r]);
      }
    }
  }

  if (config.output === 'json' || config.output === 'both') {
    writeJsonReport(report, config.outputFile);
  }

  // Always generate HTML report (with timestamp to avoid overwriting)
  const htmlDir = require('path').resolve(__dirname, '..', 'tmp');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const htmlPath = cliArgs.outputFile && cliArgs.outputFile.endsWith('.html')
    ? cliArgs.outputFile
    : require('path').join(htmlDir, `benchmark-report-${ts}.html`);
  writeHtmlReport(report, config, htmlPath);

  // Historical comparison
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
