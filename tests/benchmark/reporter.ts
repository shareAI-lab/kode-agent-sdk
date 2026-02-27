import fs from 'fs';
import path from 'path';
import type {
  BenchmarkConfig,
  BenchmarkReport,
  SWEProviderResult,
  TAUProviderResult,
  TB2Summary,
} from './types';

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function lpad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : ' '.repeat(len - s.length) + s;
}

function trunc(s: string, len: number): string {
  return s.length <= len ? s : s.slice(0, len - 1) + '\u2026';
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

interface Column {
  header: string;
  width: number;
  align: 'left' | 'right';
}

function buildTable(columns: Column[], rows: string[][]): string {
  const sep = columns.map(c => '-'.repeat(c.width)).join('-+-');
  const headerLine = columns
    .map(c => (c.align === 'right' ? lpad(c.header, c.width) : pad(c.header, c.width)))
    .join(' | ');

  const lines: string[] = [headerLine, sep];
  for (const row of rows) {
    const cells = columns.map((c, i) => {
      const val = row[i] ?? '';
      return c.align === 'right' ? lpad(val, c.width) : pad(val, c.width);
    });
    lines.push(cells.join(' | '));
  }
  return lines.join('\n');
}

export function printProviderSummary(config: BenchmarkConfig): void {
  const runSWE = config.benchmark === 'swe' || config.benchmark === 'both' || config.benchmark === 'all';
  const runTAU = config.benchmark === 'tau' || config.benchmark === 'both' || config.benchmark === 'all';
  const runTB2 = config.benchmark === 'tb2' || config.benchmark === 'both' || config.benchmark === 'all';
  const banner = '='.repeat(80);
  console.log(`\n${banner}`);
  console.log('KODE SDK Benchmark Runner');
  console.log(banner);
  console.log(`  SDK version:   ${config.sdkVersion}`);
  console.log(`  Benchmark:     ${config.benchmark}`);
  console.log(`  Timeout:       ${config.timeoutMs}ms`);
  console.log(`  Output:        ${config.output}`);
  console.log('');

  if (runSWE || runTAU) {
    if (config.providers.length === 0) {
      console.log('  Providers:     (none discovered)');
    } else {
      console.log('  Providers:');
      for (const p of config.providers) {
        console.log(`    - ${p.id} / ${p.model}`);
      }
    }
  }

  if (runTAU) {
    console.log(`  TAU domain:    ${config.tauDomain}`);
    console.log(`  Num trials:    ${config.numTrials}`);
    if (config.userSimProvider) {
      console.log(`  User sim:      ${config.userSimProvider.id} / ${config.userSimProvider.model}`);
    }
  }

  if (runTB2) {
    console.log(`  TB2 dataset:   ${config.tb2Dataset}`);
    console.log(`  TB2 agent:     ${config.tb2Agent}`);
    if (config.tb2Model) console.log(`  TB2 model:     ${config.tb2Model}`);
    console.log(`  TB2 runner:    ${config.tb2Runner}`);
    console.log(`  TB2 jobs dir:  ${config.tb2JobsDir}`);
  }

  if (config.dockerProxy) {
    console.log(`  Docker proxy:  ${config.dockerProxy}`);
  }

  console.log('');
}

export function printSWETable(dataset: string, instanceCount: number, results: SWEProviderResult[]): void {
  console.log(`\n--- SWE-bench (${dataset}) — ${instanceCount} instances ---\n`);

  const columns: Column[] = [
    { header: 'Provider / Model', width: 36, align: 'left' },
    { header: 'Resolved', width: 8, align: 'right' },
    { header: 'Rate', width: 7, align: 'right' },
    { header: 'Avg Tokens', width: 10, align: 'right' },
    { header: 'Avg ms', width: 8, align: 'right' },
  ];

  const rows = results.map(r => [
    trunc(`${r.provider.id} / ${r.provider.model}`, 36),
    `${r.summary.resolved}/${r.summary.total}`,
    fmtPct(r.summary.rate),
    fmtK(r.summary.avg_tokens),
    fmtK(r.summary.avg_duration_ms),
  ]);

  console.log(buildTable(columns, rows));
  console.log('');
}

export function printTAUTable(
  domain: string,
  taskCount: number,
  numTrials: number,
  results: TAUProviderResult[],
): void {
  console.log(`\n--- TAU-bench (${domain}) — ${taskCount} tasks, ${numTrials} trials ---\n`);

  const passColumns: Column[] = [];
  for (let k = 1; k <= numTrials; k++) {
    passColumns.push({ header: `Pass^${k}`, width: 7, align: 'right' });
  }

  const columns: Column[] = [
    { header: 'Provider / Model', width: 36, align: 'left' },
    ...passColumns,
    { header: 'Avg Tokens', width: 10, align: 'right' },
  ];

  const rows = results.map(r => {
    const passValues = r.summary.pass_at_k.map(v => fmtPct(v));
    while (passValues.length < numTrials) passValues.push('-');
    const tokenCell = (r.summary.token_observed_trials ?? 0) > 0 ? fmtK(r.summary.avg_tokens) : '-';
    return [
      trunc(`${r.provider.id} / ${r.provider.model}`, 36),
      ...passValues,
      tokenCell,
    ];
  });

  console.log(buildTable(columns, rows));
  console.log('');
}

export function printTB2Summary(summary: TB2Summary): void {
  console.log('\n=== Terminal Bench 2.0 Score ===');
  console.log(`Job path: ${summary.job_path}`);
  console.log(`Passed:   ${summary.passed}/${summary.total}`);
  console.log(`Rate:     ${fmtPct(summary.rate)}`);
  console.log(`Unknown:  ${summary.unknown}`);
  if ((summary.token_observed_trials ?? 0) > 0 && summary.avg_total_tokens !== undefined) {
    console.log(`Avg tok:  ${fmtK(summary.avg_total_tokens)} (observed ${summary.token_observed_trials}/${summary.total})`);
  } else {
    console.log('Avg tok:  N/A');
  }
  console.log('');
}

export function redactReport(report: BenchmarkReport): BenchmarkReport {
  return JSON.parse(JSON.stringify(report, (key, value) => {
    if (key === 'apiKey' && typeof value === 'string') return '***';
    return value;
  }));
}

export function writeJsonReport(report: BenchmarkReport, filePath: string): void {
  const redacted = redactReport(report);
  const json = JSON.stringify(redacted, null, 2);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, json, 'utf-8');
  console.log(`  JSON report written to: ${filePath}`);
}
