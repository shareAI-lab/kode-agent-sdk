import fs from 'fs';
import type {
  BenchmarkConfig,
  BenchmarkReport,
  SWEProviderResult,
  TAUProviderResult,
} from './types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

  const lines: string[] = [];
  lines.push(headerLine);
  lines.push(sep);

  for (const row of rows) {
    const cells = columns.map((c, i) => {
      const val = row[i] ?? '';
      return c.align === 'right' ? lpad(val, c.width) : pad(val, c.width);
    });
    lines.push(cells.join(' | '));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function printProviderSummary(config: BenchmarkConfig): void {
  const banner = '='.repeat(80);
  console.log(`\n${banner}`);
  console.log('KODE SDK Benchmark Runner');
  console.log(banner);
  console.log(`  SDK version:   ${config.sdkVersion}`);
  console.log(`  Timeout:       ${config.timeoutMs}ms`);
  console.log(`  Num trials:    ${config.numTrials}`);
  console.log(`  Output:        ${config.output}`);
  console.log(`  SWE mode:      ${config.sweMode}`);
  console.log(`  TAU domain:    ${config.tauDomain}`);
  console.log('');

  if (config.providers.length === 0) {
    console.log('  Providers:     (none discovered)');
  } else {
    console.log('  Providers:');
    for (const p of config.providers) {
      console.log(`    - ${p.id} / ${p.model}`);
    }
  }

  if (config.userSimProvider) {
    console.log(`  User sim:      ${config.userSimProvider.id} / ${config.userSimProvider.model}`);
  }

  if (config.dockerProxy) {
    console.log(`  Docker proxy:  ${config.dockerProxy}`);
  }

  console.log('');
}

export function printSWETable(
  dataset: string,
  instanceCount: number,
  results: SWEProviderResult[],
): void {
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
    (r.summary.rate * 100).toFixed(1) + '%',
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
    const passValues = r.summary.pass_at_k.map(v => (v * 100).toFixed(1) + '%');
    // Pad if fewer values than numTrials
    while (passValues.length < numTrials) passValues.push('-');
    return [
      trunc(`${r.provider.id} / ${r.provider.model}`, 36),
      ...passValues,
      fmtK(r.summary.avg_tokens),
    ];
  });

  console.log(buildTable(columns, rows));
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
  fs.writeFileSync(filePath, json, 'utf-8');
  console.log(`  JSON report written to: ${filePath}`);
}

export function printNoBenchmarks(): void {
  console.log('  No benchmark modules configured yet.');
  console.log('  SWE and TAU modules will be added in Phase 2 and Phase 3.');
  console.log('  Framework scaffolding verified successfully.');
  console.log('');
}
