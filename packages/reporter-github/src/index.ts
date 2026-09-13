import type { CheckStatus } from '@perfsense/core';
import type { CorrelationResult, LikelyCause } from '@perfsense/correlation-engine';
import {
  formatDeltaPercent,
  formatFixtureName,
  formatMetricValue,
  getApprovedMetrics,
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

/** Professional status words used in the report (no emojis/decorative marks). */
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

/** Renders a fixture's summary table, filtering to approved matrix metrics. */
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

function regressionBlock(
  entry: CheckResultEntry,
  correlation: CorrelationResult | undefined,
): string[] {
  const lines: string[] = [];
  const headingDelta = `${entry.deltaPercent >= 0 ? '+' : ''}${entry.deltaPercent.toFixed(1)}%`;
  lines.push(`### ${entry.metric} — ${headingDelta}`);
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

  // ── Performance Summary ──────────────────────────────────────────────
  const grouped: Map<string, CheckResultEntry[]> = new Map();
  for (const r of result.results) {
    if (!isKnownFixture(r.page)) continue;
    if (!isMetricApproved(r.page, r.metric)) continue;
    const list = grouped.get(r.page) ?? [];
    list.push(r);
    grouped.set(r.page, list);
  }

  lines.push('## Performance Summary');
  lines.push('');
  for (const [fixture, entries] of grouped) {
    lines.push(`### ${formatFixtureName(fixture)}`);
    lines.push('');
    lines.push(...fixtureTable(entries));
    lines.push('');
  }

  if (grouped.size === 0) {
    lines.push('No benchmark results match the approved Benchmark Matrix.');
    lines.push('');
  }

  // ── Performance Regressions ──────────────────────────────────────────
  const regressions = result.results.filter(
    (r) => r.status === 'REGRESSION' && isMetricApproved(r.page, r.metric) && !isMetricUnverified(r.page, r.metric),
  );

  lines.push('## Performance Regressions');
  lines.push('');
  if (regressions.length === 0) {
    lines.push('No performance regressions detected.');
    lines.push('');
  }
  for (const r of regressions) {
    lines.push(...regressionBlock(r, result.correlation));
  }

  // ── Artifacts ────────────────────────────────────────────────────────
  lines.push('## Artifacts');
  lines.push('');
  lines.push('- [Full results JSON](./perfsense-results.json)');
  lines.push('');

  return lines.join('\n');
}