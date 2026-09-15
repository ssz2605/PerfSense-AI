import type { CheckStatus } from '@perfsense/core';
import type { CorrelationResult, LikelyCause } from '@perfsense/correlation-engine';
import {
  BENCHMARK_MATRIX,
  formatDeltaPercent,
  formatFixtureName,
  formatMetricValue,
  isMetricApproved,
  isMetricUnverified,
  isKnownFixture,
} from '@perfsense/benchmark-matrix';

export interface CheckResultEntry {
  page: string;
  metric: string;
  status: CheckStatus;
  deltaPercent: number;
  baselineMedian: number;
  currentMedian: number;
  failThreshold: number;
}

export interface CheckResult {
  results: CheckResultEntry[];
  summary: {
    pass: number;
    warning: number;
    regression: number;
    failed: boolean;
  };
  correlation?: CorrelationResult;
  correlationError?: string;
}

export interface PRReportOptions {
  /** Pull-request number, e.g. "27". */
  pr?: string;
  /** Head commit short/long SHA. */
  head?: string;
  /** Baseline reference, e.g. "origin/master". */
  baselineRef?: string;
  /** Benchmark matrix label shown in the header. */
  matrix?: string;
  /** Optional free-form AI analysis (collapsed section). */
  aiAnalysis?: string;
}

/** Professional status words used in the full metrics table (no emojis). */
export function statusWord(status: CheckStatus, deltaPercent: number): string {
  if (status === 'REGRESSION') return 'Regression';
  if (status === 'WARNING') return 'Warning';
  if (deltaPercent < 0) return 'Improved';
  return 'Passed';
}

function findCorrelation(
  correlation: CorrelationResult | undefined,
  metric: string,
): { metricCorrelation: import('@perfsense/correlation-engine').MetricCorrelation | undefined; lc: LikelyCause | null } {
  if (!correlation) return { metricCorrelation: undefined, lc: null };
  const key = Object.keys(correlation.metrics).find(
    (k) => k.toLowerCase() === metric.toLowerCase(),
  ) ?? metric.toLowerCase();
  const metricCorrelation = correlation.metrics[key];
  return { metricCorrelation, lc: metricCorrelation?.likelyCause ?? null };
}

function findCrossMetricCause(
  correlation: CorrelationResult | undefined,
  metric: string,
): import('@perfsense/correlation-engine').CrossMetricCause | undefined {
  return correlation?.crossMetricCauses.find((c) =>
    c.affectedMetrics.some((m) => m.toLowerCase() === metric.toLowerCase()),
  );
}

function formatSource(c: { source: string; sourceLocation?: { originalFile: string; originalLine: number } }): string {
  return c.sourceLocation
    ? `${c.sourceLocation.originalFile}:${c.sourceLocation.originalLine}`
    : c.source;
}

/** Renders a fixture's full metric table (used in the collapsible section). */
function fixtureTable(entries: CheckResultEntry[]): string[] {
  const lines: string[] = [];
  lines.push('| Metric | Baseline | Current | Delta | Status |');
  lines.push('|---|---:|---:|---:|---|');
  const fixture = entries[0].page;
  for (const e of entries) {
    const status = isMetricUnverified(fixture, e.metric)
      ? 'Unverified'
      : statusWord(e.status, e.deltaPercent);
    lines.push(
      `| ${e.metric} | ${formatMetricValue(e.baselineMedian, e.metric)} | ${formatMetricValue(e.currentMedian, e.metric)} | ${formatDeltaPercent(e.deltaPercent)} | ${status} |`,
    );
  }
  return lines;
}

/** Cause + AI analysis lines for a regression/warning detail block. */
function causeLines(
  entry: CheckResultEntry,
  correlation: CorrelationResult | undefined,
): string[] {
  const lines: string[] = [];
  lines.push(`Baseline: ${formatMetricValue(entry.baselineMedian, entry.metric)} | Current: ${formatMetricValue(entry.currentMedian, entry.metric)}`);
  lines.push('');

  const { lc } = findCorrelation(correlation, entry.metric);
  if (lc) {
    lines.push(`**Likely cause:** \`${formatSource(lc)}\``);
    if (lc.causeEvidence?.function) {
      lines.push(`**Function:** ${lc.causeEvidence.function}`);
    }
    lines.push('');
    lines.push('**AI analysis:**');
    lines.push(lc.rationale ?? lc.description);
    lines.push('');
    return lines;
  }

  const cmc = findCrossMetricCause(correlation, entry.metric);
  if (cmc) {
    lines.push(`**Likely cause:** \`${formatSource(cmc)}\``);
    lines.push('');
    lines.push('**AI analysis:**');
    lines.push(
      `${cmc.description} This source affects ${cmc.affectedMetrics.join(', ')} and is shared across those metrics.`,
    );
    lines.push('');
    return lines;
  }

  lines.push('**Likely cause:** No likely cause identified.');
  lines.push('');
  return lines;
}

interface FixtureView {
  fixture: string;
  displayName: string;
  entries: CheckResultEntry[];
}

/** Groups approved entries per fixture, in Benchmark Matrix order. */
function groupByFixture(result: CheckResult): FixtureView[] {
  const byFixture = new Map<string, CheckResultEntry[]>();
  for (const r of result.results) {
    if (!isKnownFixture(r.page)) continue;
    if (!isMetricApproved(r.page, r.metric)) continue;
    const list = byFixture.get(r.page) ?? [];
    list.push(r);
    byFixture.set(r.page, list);
  }
  const views: FixtureView[] = [];
  for (const contract of BENCHMARK_MATRIX) {
    const entries = byFixture.get(contract.fixture);
    if (entries && entries.length > 0) {
      views.push({ fixture: contract.fixture, displayName: contract.displayName, entries });
    }
  }
  return views;
}

/** Verified (non-unverified) entries of a fixture. */
function verifiedEntries(view: FixtureView): CheckResultEntry[] {
  return view.entries.filter((e) => !isMetricUnverified(view.fixture, e.metric));
}

/** True when the improvement is large enough to be reportable. */
function isMeaningfulImprovement(entry: CheckResultEntry): boolean {
  return entry.status === 'PASS' && entry.deltaPercent <= -10;
}

interface FixtureSummaryStatus {
  icon: string;
  label: string;
}

function fixtureSummaryStatus(view: FixtureView): FixtureSummaryStatus {
  const verified = verifiedEntries(view);
  if (verified.some((e) => e.status === 'REGRESSION')) return { icon: '🔴', label: 'Regression' };
  if (verified.some((e) => e.status === 'WARNING')) return { icon: '🟡', label: 'Warning' };
  if (verified.some(isMeaningfulImprovement)) return { icon: '🟢', label: 'Improved' };
  return { icon: '✅', label: 'Passed' };
}

/** Detail block heading + numbers + cause for one notable metric. */
function detailBlock(
  entry: CheckResultEntry,
  correlation: CorrelationResult | undefined,
  icon: string,
): string[] {
  const lines: string[] = [];
  lines.push(`${icon} **${entry.metric}** — ${formatDeltaPercent(entry.deltaPercent)}`);
  lines.push('');
  lines.push(...causeLines(entry, correlation));
  return lines;
}

export function generatePRComment(
  result: CheckResult,
  options: PRReportOptions = {},
): string {
  const lines: string[] = [];

  lines.push('# PerfSense Performance Report');
  lines.push('');
  if (options.pr) lines.push(`PR: ${options.pr}`);
  if (options.head) lines.push(`Head: ${options.head}`);
  if (options.baselineRef) lines.push(`Baseline: ${options.baselineRef}`);
  if (options.matrix) lines.push(`Matrix: ${options.matrix}`);
  if (options.pr || options.head || options.baselineRef || options.matrix) lines.push('');

  const views = groupByFixture(result);

  const verified = views.flatMap((v) => verifiedEntries(v));
  const regressions = verified.filter((e) => e.status === 'REGRESSION');
  const warnings = verified.filter((e) => e.status === 'WARNING');

  // ── Performance Check (overall status + fixture summary) ─────────────
  lines.push('## Performance Check');
  lines.push('');
  if (regressions.length > 0) {
    lines.push('🔴 Performance regression detected');
    lines.push('');
    lines.push(
      `${regressions.length} regression(s) and ${warnings.length} warning(s) across approved metrics.`,
    );
  } else if (warnings.length > 0) {
    lines.push('🟡 No significant regression');
    lines.push('');
    lines.push(
      `${warnings.length} warning(s) across approved metrics — no metric exceeded its regression threshold.`,
    );
  } else {
    lines.push('🟢 No significant regression');
  }
  lines.push('');

  lines.push('### Fixture summary');
  lines.push('');
  lines.push('| Fixture | Result |');
  lines.push('|---|---|');
  for (const view of views) {
    const s = fixtureSummaryStatus(view);
    lines.push(`| ${view.displayName} | ${s.icon} ${s.label} |`);
  }
  if (views.length === 0) {
    lines.push('| (no approved benchmark results) | — |');
  }
  lines.push('');

  // ── Details: notable regressions/improvements per fixture ────────────
  lines.push('## Details');
  lines.push('');
  let anyNotable = false;
  for (const view of views) {
    const notable = verifiedEntries(view).filter(
      (e) => e.status === 'REGRESSION' || isMeaningfulImprovement(e),
    );
    if (notable.length === 0) continue;
    anyNotable = true;
    lines.push(`### ${view.displayName}`);
    lines.push('');
    for (const entry of notable) {
      if (entry.status === 'REGRESSION') {
        lines.push(...detailBlock(entry, result.correlation, '🔴'));
      } else {
        lines.push(...detailBlock(entry, result.correlation, '🟢'));
      }
    }
  }
  if (!anyNotable) {
    lines.push('No regressions or meaningful improvements detected.');
    lines.push('');
  }

  // ── Full approved metrics (collapsible) ──────────────────────────────
  lines.push('<details>');
  lines.push('<summary>All approved metrics</summary>');
  lines.push('');
  for (const view of views) {
    lines.push(`### ${view.displayName}`);
    lines.push('');
    lines.push(...fixtureTable(view.entries));
    lines.push('');
  }
  if (views.length === 0) {
    lines.push('No benchmark results match the approved Benchmark Matrix.');
    lines.push('');
  }
  lines.push('</details>');
  lines.push('');

  // ── Artifacts ────────────────────────────────────────────────────────
  lines.push('## Artifacts');
  lines.push('');
  lines.push('- [Full results JSON](./perfsense-results.json)');
  lines.push('');

  return lines.join('\n');
}