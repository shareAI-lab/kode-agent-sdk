import fs from 'fs';
import path from 'path';
import type { BenchmarkConfig, BenchmarkReport, SWEProviderResult, TAUProviderResult } from './types';
import { redactReport } from './reporter';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function writeHtmlReport(
  report: BenchmarkReport,
  config: BenchmarkConfig,
  filePath: string,
): void {
  const safe = redactReport(report);
  const html = buildHtml(safe, config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, html, 'utf-8');
  console.log(`  HTML report written to: ${filePath}`);
}

// ---------------------------------------------------------------------------
// Score calculation
// ---------------------------------------------------------------------------

function computeOverallScore(report: BenchmarkReport): number | null {
  const scores: { value: number; weight: number }[] = [];

  if (report.swe && report.swe.length > 0) {
    // Average SWE rate across all providers
    const avgRate = report.swe.reduce((s, r) => s + r.summary.rate, 0) / report.swe.length;
    scores.push({ value: avgRate * 100, weight: 60 });
  }

  if (report.tau && report.tau.length > 0) {
    // Average TAU pass^1 across all providers
    const avgPass = report.tau.reduce((s, r) => {
      const p1 = r.summary.pass_at_k[0] ?? 0;
      return s + p1;
    }, 0) / report.tau.length;
    scores.push({ value: avgPass * 100, weight: 40 });
  }

  if (scores.length === 0) return null;

  // If only one type ran, it gets 100% weight
  const totalWeight = scores.reduce((s, x) => s + x.weight, 0);
  return scores.reduce((s, x) => s + (x.value * x.weight) / totalWeight, 0);
}

function scoreColor(score: number): string {
  if (score >= 90) return '#22c55e';
  if (score >= 70) return '#eab308';
  if (score >= 50) return '#f97316';
  return '#ef4444';
}

function scoreLabel(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Poor';
}

// ---------------------------------------------------------------------------
// HTML builder
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function buildHtml(report: BenchmarkReport, config: BenchmarkConfig): string {
  const score = computeOverallScore(report);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Benchmark Report — KODE SDK ${esc(report.sdk_version)}</title>
${buildStyle()}
</head>
<body>
<div class="container">
  <header>
    <h1>KODE SDK Benchmark Report</h1>
    <p class="subtitle">Generated ${esc(report.timestamp)}</p>
  </header>

  ${buildScoreSection(score)}
  ${buildSummaryCard(report, config)}
  ${report.swe && report.swe.length > 0 ? buildSWESection(report.swe) : ''}
  ${report.tau && report.tau.length > 0 ? buildTAUSection(report.tau) : ''}

  <footer>
    <p>KODE SDK v${esc(report.sdk_version)} &middot; Benchmark Suite</p>
  </footer>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function buildScoreSection(score: number | null): string {
  if (score === null) {
    return `<section class="score-section">
      <div class="score-ring" style="--score-color: #94a3b8">
        <span class="score-value">N/A</span>
      </div>
      <p class="score-label">No benchmark data</p>
    </section>`;
  }
  const rounded = Math.round(score * 10) / 10;
  const color = scoreColor(rounded);
  const label = scoreLabel(rounded);
  const pct = Math.min(rounded, 100);
  return `<section class="score-section">
    <div class="score-ring" style="--score-color: ${color}; --pct: ${pct}">
      <svg viewBox="0 0 120 120">
        <circle class="score-bg" cx="60" cy="60" r="54"/>
        <circle class="score-fg" cx="60" cy="60" r="54"
          stroke-dasharray="${(pct / 100) * 339.292} 339.292"/>
      </svg>
      <span class="score-value">${rounded.toFixed(1)}</span>
    </div>
    <p class="score-label" style="color:${color}">${label}</p>
    <p class="score-desc">Weighted: SWE 60% + TAU 40%</p>
  </section>`;
}

function buildSummaryCard(report: BenchmarkReport, config: BenchmarkConfig): string {
  const providers = config.providers.map(p => `<span class="tag">${esc(p.id)} / ${esc(p.model)}</span>`).join(' ');
  return `<section class="card">
    <h2>Configuration</h2>
    <div class="grid">
      <div class="kv"><span class="k">SDK Version</span><span class="v">${esc(report.sdk_version)}</span></div>
      <div class="kv"><span class="k">SWE Mode</span><span class="v">${esc(config.sweMode)}</span></div>
      <div class="kv"><span class="k">TAU Domain</span><span class="v">${esc(config.tauDomain)}</span></div>
      <div class="kv"><span class="k">Timeout</span><span class="v">${config.timeoutMs}ms</span></div>
      <div class="kv"><span class="k">Num Trials</span><span class="v">${config.numTrials}</span></div>
    </div>
    <div class="providers"><strong>Providers:</strong> ${providers}</div>
  </section>`;
}

function buildSWESection(results: SWEProviderResult[]): string {
  let html = `<section class="card">
    <h2>SWE-bench Results</h2>`;

  // Summary table
  html += `<table>
    <thead><tr>
      <th>Provider / Model</th><th>Dataset</th><th>Resolved</th><th>Rate</th><th>Avg Tokens</th><th>Avg Duration</th>
    </tr></thead><tbody>`;

  for (const r of results) {
    const rate = (r.summary.rate * 100).toFixed(1);
    const color = scoreColor(r.summary.rate * 100);
    html += `<tr>
      <td>${esc(r.provider.id)} / ${esc(r.provider.model)}</td>
      <td>${esc(r.summary.dataset)}</td>
      <td>${r.summary.resolved}/${r.summary.total}</td>
      <td><span class="rate-badge" style="background:${color}">${rate}%</span></td>
      <td>${fmtK(r.summary.avg_tokens)}</td>
      <td>${fmtK(r.summary.avg_duration_ms)}ms</td>
    </tr>`;
  }
  html += `</tbody></table>`;

  // Bar chart
  html += `<div class="chart-title">Resolved Rate by Provider</div><div class="bar-chart">`;
  for (const r of results) {
    const pct = (r.summary.rate * 100).toFixed(1);
    const color = scoreColor(r.summary.rate * 100);
    const label = `${r.provider.id} / ${r.provider.model}`;
    html += `<div class="bar-row">
      <span class="bar-label">${esc(label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="bar-value">${pct}%</span>
    </div>`;
  }
  html += `</div>`;

  // Per-case details
  for (const r of results) {
    html += `<details class="detail-block">
      <summary>${esc(r.provider.id)} / ${esc(r.provider.model)} — Case Details (${r.results.length} cases)</summary>
      <table class="detail-table"><thead><tr>
        <th>Case ID</th><th>Status</th><th>Tokens</th><th>Duration</th><th>Error</th>
      </tr></thead><tbody>`;
    for (const c of r.results) {
      const status = c.resolved
        ? '<span class="pass">PASS</span>'
        : '<span class="fail">FAIL</span>';
      html += `<tr>
        <td>${esc(c.instance_id)}</td><td>${status}</td>
        <td>${fmtK(c.tokens_used)}</td><td>${fmtK(c.duration_ms)}ms</td>
        <td>${c.error ? esc(c.error) : '-'}</td>
      </tr>`;
    }
    html += `</tbody></table></details>`;
  }

  html += `</section>`;
  return html;
}

function buildTAUSection(results: TAUProviderResult[]): string {
  let html = `<section class="card">
    <h2>TAU-bench Results</h2>`;

  // Determine max k from results
  const maxK = results.reduce((m, r) => Math.max(m, r.summary.pass_at_k.length), 0);

  // Summary table
  html += `<table><thead><tr>
    <th>Provider / Model</th><th>Domain</th>`;
  for (let k = 1; k <= maxK; k++) {
    html += `<th>Pass^${k}</th>`;
  }
  html += `<th>Avg Tokens</th></tr></thead><tbody>`;

  for (const r of results) {
    html += `<tr>
      <td>${esc(r.provider.id)} / ${esc(r.provider.model)}</td>
      <td>${esc(r.summary.domain)}</td>`;
    for (let k = 0; k < maxK; k++) {
      const val = r.summary.pass_at_k[k];
      if (val !== undefined) {
        const pct = (val * 100).toFixed(1);
        const color = scoreColor(val * 100);
        html += `<td><span class="rate-badge" style="background:${color}">${pct}%</span></td>`;
      } else {
        html += `<td>-</td>`;
      }
    }
    html += `<td>${fmtK(r.summary.avg_tokens)}</td></tr>`;
  }
  html += `</tbody></table>`;

  // Bar chart (pass^1)
  html += `<div class="chart-title">Pass^1 Rate by Provider</div><div class="bar-chart">`;
  for (const r of results) {
    const p1 = r.summary.pass_at_k[0] ?? 0;
    const pct = (p1 * 100).toFixed(1);
    const color = scoreColor(p1 * 100);
    const label = `${r.provider.id} / ${r.provider.model} (${r.summary.domain})`;
    html += `<div class="bar-row">
      <span class="bar-label">${esc(label)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="bar-value">${pct}%</span>
    </div>`;
  }
  html += `</div>`;

  // Per-task details
  for (const r of results) {
    html += `<details class="detail-block">
      <summary>${esc(r.provider.id)} / ${esc(r.provider.model)} (${esc(r.summary.domain)}) — Task Details (${r.results.length} tasks)</summary>
      <table class="detail-table"><thead><tr>
        <th>Task ID</th><th>Trials</th><th>Tokens</th><th>Error</th>
      </tr></thead><tbody>`;
    for (const t of r.results) {
      const trials = t.trial_pass_rates
        .map(p => p ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>')
        .join(' ');
      html += `<tr>
        <td>${esc(t.task_id)}</td><td>${trials}</td>
        <td>${fmtK(t.tokens_used)}</td>
        <td>${t.error ? esc(t.error) : '-'}</td>
      </tr>`;
    }
    html += `</tbody></table></details>`;
  }

  html += `</section>`;
  return html;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function buildStyle(): string {
  return `<style>
  :root { --bg: #0f172a; --surface: #1e293b; --border: #334155; --text: #e2e8f0; --muted: #94a3b8; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
  .container { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem; }
  header { text-align: center; margin-bottom: 2rem; }
  header h1 { font-size: 1.75rem; font-weight: 700; }
  .subtitle { color: var(--muted); font-size: 0.875rem; margin-top: 0.25rem; }
  footer { text-align: center; color: var(--muted); font-size: 0.75rem; margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border); }

  /* Score ring */
  .score-section { text-align: center; margin-bottom: 2rem; }
  .score-ring { position: relative; width: 140px; height: 140px; margin: 0 auto; }
  .score-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
  .score-bg { fill: none; stroke: var(--border); stroke-width: 8; }
  .score-fg { fill: none; stroke: var(--score-color); stroke-width: 8; stroke-linecap: round; transition: stroke-dasharray 0.6s ease; }
  .score-value { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 1.75rem; font-weight: 700; color: var(--score-color); }
  .score-label { font-size: 1.125rem; font-weight: 600; margin-top: 0.5rem; }
  .score-desc { color: var(--muted); font-size: 0.75rem; margin-top: 0.125rem; }

  /* Cards */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.5rem; margin-bottom: 1.5rem; }
  .card h2 { font-size: 1.25rem; margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }

  /* Grid */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
  .kv { display: flex; flex-direction: column; }
  .k { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .v { font-size: 1rem; font-weight: 600; }

  /* Tags */
  .tag { display: inline-block; background: var(--border); padding: 0.2rem 0.6rem; border-radius: 0.375rem; font-size: 0.8rem; margin: 0.125rem; }
  .providers { margin-top: 0.5rem; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.875rem; }
  th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  tr:hover { background: rgba(255,255,255,0.03); }

  /* Rate badge */
  .rate-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 0.25rem; color: #fff; font-weight: 600; font-size: 0.8rem; }

  .pass { color: #22c55e; font-weight: 600; }
  .fail { color: #ef4444; font-weight: 600; }

  /* Bar chart */
  .chart-title { font-size: 0.875rem; font-weight: 600; margin: 1.25rem 0 0.5rem; }
  .bar-chart { display: flex; flex-direction: column; gap: 0.5rem; }
  .bar-row { display: flex; align-items: center; gap: 0.75rem; }
  .bar-label { width: 220px; font-size: 0.8rem; text-align: right; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; height: 22px; background: var(--border); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.4s ease; min-width: 2px; }
  .bar-value { width: 52px; font-size: 0.8rem; font-weight: 600; text-align: right; flex-shrink: 0; }

  /* Detail blocks */
  .detail-block { margin-top: 1rem; }
  .detail-block summary { cursor: pointer; font-size: 0.875rem; font-weight: 600; color: var(--muted); padding: 0.5rem 0; }
  .detail-block summary:hover { color: var(--text); }
  .detail-table { font-size: 0.8rem; }

  @media (max-width: 640px) {
    .bar-label { width: 100px; }
    .grid { grid-template-columns: 1fr 1fr; }
  }
</style>`;
}
