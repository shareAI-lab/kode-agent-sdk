// ---------------------------------------------------------------------------
// Benchmark report comparison — compare two JSON reports side-by-side
// ---------------------------------------------------------------------------

import fs from 'fs';
import type { BenchmarkReport, SWEProviderResult, TAUProviderResult } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ComparisonRow {
  label: string;
  oldValue: string;
  newValue: string;
  delta: string;
  direction: 'better' | 'worse' | 'same' | 'na';
}

interface ComparisonResult {
  swe: ComparisonRow[];
  tau: ComparisonRow[];
  hasRegressions: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function deltaStr(oldVal: number, newVal: number, unit: 'pct' | 'tokens' | 'ms'): { text: string; dir: 'better' | 'worse' | 'same' } {
  const diff = newVal - oldVal;
  if (Math.abs(diff) < 0.001) return { text: '=', dir: 'same' };

  const sign = diff > 0 ? '+' : '';
  let text: string;

  switch (unit) {
    case 'pct':
      text = `${sign}${(diff * 100).toFixed(1)}pp`;
      return { text, dir: diff > 0 ? 'better' : 'worse' };
    case 'tokens':
      text = `${sign}${fmtK(diff)}`;
      // Lower tokens = better
      return { text, dir: diff < 0 ? 'better' : 'worse' };
    case 'ms':
      text = `${sign}${fmtK(diff)}`;
      // Lower duration = better
      return { text, dir: diff < 0 ? 'better' : 'worse' };
  }
}

// ---------------------------------------------------------------------------
// Comparison logic
// ---------------------------------------------------------------------------

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

    // Rate
    const rateD = deltaStr(oldR.summary.rate, newR.summary.rate, 'pct');
    rows.push({
      label: `${key} [rate]`,
      oldValue: fmtPct(oldR.summary.rate),
      newValue: fmtPct(newR.summary.rate),
      delta: rateD.text,
      direction: rateD.dir,
    });

    // Resolved count
    rows.push({
      label: `${key} [resolved]`,
      oldValue: `${oldR.summary.resolved}/${oldR.summary.total}`,
      newValue: `${newR.summary.resolved}/${newR.summary.total}`,
      delta: newR.summary.resolved === oldR.summary.resolved ? '=' : `${newR.summary.resolved - oldR.summary.resolved > 0 ? '+' : ''}${newR.summary.resolved - oldR.summary.resolved}`,
      direction: newR.summary.resolved > oldR.summary.resolved ? 'better' : newR.summary.resolved < oldR.summary.resolved ? 'worse' : 'same',
    });

    // Avg tokens
    const tokD = deltaStr(oldR.summary.avg_tokens, newR.summary.avg_tokens, 'tokens');
    rows.push({
      label: `${key} [tokens]`,
      oldValue: fmtK(oldR.summary.avg_tokens),
      newValue: fmtK(newR.summary.avg_tokens),
      delta: tokD.text,
      direction: tokD.dir,
    });
  }

  return rows;
}

function compareTAU(oldResults: TAUProviderResult[], newResults: TAUProviderResult[]): ComparisonRow[] {
  const rows: ComparisonRow[] = [];

  for (const newR of newResults) {
    const key = `${newR.provider.id}/${newR.provider.model} [${newR.summary.domain}]`;
    const oldR = oldResults.find(
      r =>
        r.provider.id === newR.provider.id &&
        r.provider.model === newR.provider.model &&
        r.summary.domain === newR.summary.domain,
    );

    if (!oldR) {
      const pass1 = newR.summary.pass_at_k[0] ?? 0;
      rows.push({
        label: `${key} [pass^1]`,
        oldValue: '-',
        newValue: fmtPct(pass1),
        delta: 'new',
        direction: 'na',
      });
      continue;
    }

    // Pass^1 (primary metric)
    const oldPass1 = oldR.summary.pass_at_k[0] ?? 0;
    const newPass1 = newR.summary.pass_at_k[0] ?? 0;
    const p1D = deltaStr(oldPass1, newPass1, 'pct');
    rows.push({
      label: `${key} [pass^1]`,
      oldValue: fmtPct(oldPass1),
      newValue: fmtPct(newPass1),
      delta: p1D.text,
      direction: p1D.dir,
    });

    // Avg tokens
    const tokD = deltaStr(oldR.summary.avg_tokens, newR.summary.avg_tokens, 'tokens');
    rows.push({
      label: `${key} [tokens]`,
      oldValue: fmtK(oldR.summary.avg_tokens),
      newValue: fmtK(newR.summary.avg_tokens),
      delta: tokD.text,
      direction: tokD.dir,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadReport(filePath: string): BenchmarkReport {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as BenchmarkReport;
}

export function compareReports(oldReport: BenchmarkReport, newReport: BenchmarkReport): ComparisonResult {
  const sweRows = compareSWE(oldReport.swe ?? [], newReport.swe ?? []);
  const tauRows = compareTAU(oldReport.tau ?? [], newReport.tau ?? []);
  const hasRegressions = [...sweRows, ...tauRows].some(r => r.direction === 'worse');

  return { swe: sweRows, tau: tauRows, hasRegressions };
}

export function printComparison(
  oldPath: string,
  newPath: string,
  result: ComparisonResult,
): void {
  const banner = '='.repeat(80);
  console.log(`\n${banner}`);
  console.log('Benchmark Comparison');
  console.log(banner);
  console.log(`  Baseline:  ${oldPath}`);
  console.log(`  Current:   ${newPath}`);
  console.log('');

  const allRows = [...result.swe, ...result.tau];

  if (allRows.length === 0) {
    console.log('  No comparable results found.');
    console.log('');
    return;
  }

  // Print table
  const maxLabel = Math.max(30, ...allRows.map(r => r.label.length));
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

  if (result.tau.length > 0) {
    console.log('--- TAU Comparison ---\n');
    console.log(header);
    console.log(sep);
    for (const row of result.tau) {
      const dir = row.direction === 'better' ? ' ^' : row.direction === 'worse' ? ' v' : '  ';
      console.log(
        `${pad(row.label, maxLabel)} | ${lpad(row.oldValue, 10)} | ${lpad(row.newValue, 10)} | ${lpad(row.delta, 12)} |${dir}`,
      );
    }
    console.log('');
  }

  if (result.hasRegressions) {
    console.log('  WARNING: Regressions detected (marked with v)');
  } else {
    console.log('  No regressions detected.');
  }
  console.log('');
}
