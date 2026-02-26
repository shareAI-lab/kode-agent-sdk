import fs from 'fs';
import type { BenchmarkReport, SWEProviderResult, TB2Summary } from './types';

interface ComparisonRow {
  label: string;
  oldValue: string;
  newValue: string;
  delta: string;
  direction: 'better' | 'worse' | 'same' | 'na';
}

interface ComparisonResult {
  swe: ComparisonRow[];
  tb2: ComparisonRow[];
  hasRegressions: boolean;
}

function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function lpad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : ' '.repeat(len - s.length) + s;
}

function deltaStr(
  oldVal: number,
  newVal: number,
  unit: 'pct' | 'tokens',
): { text: string; dir: 'better' | 'worse' | 'same' } {
  const diff = newVal - oldVal;
  if (Math.abs(diff) < 0.001) return { text: '=', dir: 'same' };

  const sign = diff > 0 ? '+' : '';
  if (unit === 'pct') {
    return { text: `${sign}${(diff * 100).toFixed(1)}pp`, dir: diff > 0 ? 'better' : 'worse' };
  }
  return { text: `${sign}${fmtK(diff)}`, dir: diff < 0 ? 'better' : 'worse' };
}

function compareSWE(oldResults: SWEProviderResult[], newResults: SWEProviderResult[]): ComparisonRow[] {
  const rows: ComparisonRow[] = [];

  for (const newR of newResults) {
    const key = `${newR.provider.id}/${newR.provider.model}`;
    const oldR = oldResults.find(
      r => r.provider.id === newR.provider.id && r.provider.model === newR.provider.model,
    );

    if (!oldR) {
      rows.push({
        label: `${key} [rate]`,
        oldValue: '-',
        newValue: fmtPct(newR.summary.rate),
        delta: 'new',
        direction: 'na',
      });
      continue;
    }

    const rateDelta = deltaStr(oldR.summary.rate, newR.summary.rate, 'pct');
    rows.push({
      label: `${key} [rate]`,
      oldValue: fmtPct(oldR.summary.rate),
      newValue: fmtPct(newR.summary.rate),
      delta: rateDelta.text,
      direction: rateDelta.dir,
    });

    rows.push({
      label: `${key} [resolved]`,
      oldValue: `${oldR.summary.resolved}/${oldR.summary.total}`,
      newValue: `${newR.summary.resolved}/${newR.summary.total}`,
      delta: newR.summary.resolved === oldR.summary.resolved
        ? '='
        : `${newR.summary.resolved - oldR.summary.resolved > 0 ? '+' : ''}${newR.summary.resolved - oldR.summary.resolved}`,
      direction: newR.summary.resolved > oldR.summary.resolved
        ? 'better'
        : newR.summary.resolved < oldR.summary.resolved
          ? 'worse'
          : 'same',
    });

    const tokenDelta = deltaStr(oldR.summary.avg_tokens, newR.summary.avg_tokens, 'tokens');
    rows.push({
      label: `${key} [tokens]`,
      oldValue: fmtK(oldR.summary.avg_tokens),
      newValue: fmtK(newR.summary.avg_tokens),
      delta: tokenDelta.text,
      direction: tokenDelta.dir,
    });
  }

  return rows;
}

function compareTB2(oldTB2?: TB2Summary, newTB2?: TB2Summary): ComparisonRow[] {
  if (!newTB2) return [];
  if (!oldTB2) {
    return [{
      label: 'tb2 [rate]',
      oldValue: '-',
      newValue: fmtPct(newTB2.rate),
      delta: 'new',
      direction: 'na',
    }];
  }

  const rows: ComparisonRow[] = [];
  const rateDelta = deltaStr(oldTB2.rate, newTB2.rate, 'pct');
  rows.push({
    label: 'tb2 [rate]',
    oldValue: fmtPct(oldTB2.rate),
    newValue: fmtPct(newTB2.rate),
    delta: rateDelta.text,
    direction: rateDelta.dir,
  });

  rows.push({
    label: 'tb2 [passed]',
    oldValue: `${oldTB2.passed}/${oldTB2.total}`,
    newValue: `${newTB2.passed}/${newTB2.total}`,
    delta: newTB2.passed === oldTB2.passed
      ? '='
      : `${newTB2.passed - oldTB2.passed > 0 ? '+' : ''}${newTB2.passed - oldTB2.passed}`,
    direction: newTB2.passed > oldTB2.passed ? 'better' : newTB2.passed < oldTB2.passed ? 'worse' : 'same',
  });

  return rows;
}

export function loadReport(filePath: string): BenchmarkReport {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BenchmarkReport;
}

export function compareReports(oldReport: BenchmarkReport, newReport: BenchmarkReport): ComparisonResult {
  const sweRows = compareSWE(oldReport.swe ?? [], newReport.swe ?? []);
  const tb2Rows = compareTB2(oldReport.tb2, newReport.tb2);
  const hasRegressions = [...sweRows, ...tb2Rows].some(r => r.direction === 'worse');
  return { swe: sweRows, tb2: tb2Rows, hasRegressions };
}

export function printComparison(oldPath: string, newPath: string, result: ComparisonResult): void {
  const banner = '='.repeat(80);
  console.log(`\n${banner}`);
  console.log('Benchmark Comparison');
  console.log(banner);
  console.log(`  Baseline:  ${oldPath}`);
  console.log(`  Current:   ${newPath}`);
  console.log('');

  const allRows = [...result.swe, ...result.tb2];
  if (allRows.length === 0) {
    console.log('  No comparable results found.\n');
    return;
  }

  const maxLabel = Math.max(20, ...allRows.map(r => r.label.length));
  const header = `${pad('Metric', maxLabel)} | ${lpad('Baseline', 10)} | ${lpad('Current', 10)} | ${lpad('Delta', 12)} | Dir`;
  const sep = '-'.repeat(header.length);

  if (result.swe.length > 0) {
    console.log('--- SWE Comparison ---\n');
    console.log(header);
    console.log(sep);
    for (const row of result.swe) {
      const dir = row.direction === 'better' ? ' ^' : row.direction === 'worse' ? ' v' : '  ';
      console.log(
        `${pad(row.label, maxLabel)} | ${lpad(row.oldValue, 10)} | ${lpad(row.newValue, 10)} | ${lpad(row.delta, 12)} |${dir}`,
      );
    }
    console.log('');
  }

  if (result.tb2.length > 0) {
    console.log('--- TB2 Comparison ---\n');
    console.log(header);
    console.log(sep);
    for (const row of result.tb2) {
      const dir = row.direction === 'better' ? ' ^' : row.direction === 'worse' ? ' v' : '  ';
      console.log(
        `${pad(row.label, maxLabel)} | ${lpad(row.oldValue, 10)} | ${lpad(row.newValue, 10)} | ${lpad(row.delta, 12)} |${dir}`,
      );
    }
    console.log('');
  }

  console.log(result.hasRegressions ? '  WARNING: Regressions detected (marked with v)' : '  No regressions detected.');
  console.log('');
}
