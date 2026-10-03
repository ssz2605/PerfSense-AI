import type { CheckStatus, ContractSummary } from '@perfsense/core';
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
  /** Null when the change is at the noise floor / missing baseline. */
  deltaPercent: number | null;
  absDelta: number | null;
  baselineMedian: number | null;
  currentMedian: number | null;
  failThreshold: number;
  pValue: number | null;
  effectSize: number | null;
  effectZ: number | null;
  confidenceInterval: [number, number] | null;
  baselineCV: number | null;
  stabilityTier: string | null;
  envMatched: boolean | null;
  baselineAgeDays: number | null;
  /** Deterministic explanation for likely-noise / inconclusive results. */
  note: string | null;
}

export interface BaselineMeta {
  envMatched: boolean | null;
  ageDays: number | null;
  stale: boolean;
  hasEnv: boolean;
  /** Which PerfSense revision produced each side of the comparison. */
  harness?: {
    baselineRef: string | null;
    runRef: string | null;
    state: 'match' | 'mismatch' | 'unknown';
  };
}

export interface CheckResult {
  results: CheckResultEntry[];
  summary: {
    pass: number;
    warning: number;
    regression: number;
    failed: boolean;
    improvement?: number;
    likelyNoise?: number;
    noBaseline?: number;
    inconclusive?: number;
  };
  correlation?: CorrelationResult;
  correlationError?: string;
  contract?: ContractSummary;
  baselineMeta?: BaselineMeta;
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
  /** Per-metric AI explanations, keyed by metric name, shown in each metric's
   *  detail block when the deterministic engine has no likely cause. */
  aiPerMetric?: Record<string, string>;
}

/** Professional status words used in the full metrics table (no emojis). */
export function statusWord(status: CheckStatus): string {
  switch (status) {
    case 'REGRESSION': return 'Regression';
    case 'WARNING': return 'Warning';
    case 'IMPROVEMENT': return 'Improvement';
    case 'LIKELY_NOISE': return 'Likely noise';
    case 'NO_BASELINE': return 'No baseline';
    case 'INCONCLUSIVE': return 'Inconclusive';
    default: return 'No meaningful change';
  }
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

function fmtMetricValue(value: number | null, metric: string): string {
  return value === null ? '—' : formatMetricValue(value, metric);
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
      : statusWord(e.status);
    lines.push(
      `| ${e.metric} | ${fmtMetricValue(e.baselineMedian, e.metric)} | ${fmtMetricValue(e.currentMedian, e.metric)} | ${formatDeltaPercent(e.deltaPercent)} | ${status} |`,
    );
  }
  return lines;
}

/** Cause + AI analysis lines for a regression/warning detail block. */
function causeLines(
  entry: CheckResultEntry,
  correlation: CorrelationResult | undefined,
  aiPerMetric?: Record<string, string>,
): string[] {
  const lines: string[] = [];

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

  // The deterministic engine found no cause — fall back to the per-metric
  // AI explanation when one was produced, so the block still explains why
  // the metric regressed instead of stopping at "No likely cause."
  const aiText = aiPerMetric ? aiPerMetric[entry.metric] : undefined;
  if (aiText) {
    lines.push('**AI analysis:**');
    lines.push(aiText);
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

interface FixtureSummaryStatus {
  icon: string;
  label: string;
}

function fixtureSummaryStatus(view: FixtureView): FixtureSummaryStatus {
  const verified = verifiedEntries(view);
  if (verified.some((e) => e.status === 'REGRESSION')) return { icon: '🔴', label: 'Regression' };
  if (verified.some((e) => e.status === 'WARNING')) return { icon: '🟠', label: 'Warning' };
  if (verified.some((e) => e.status === 'IMPROVEMENT')) return { icon: '🟢', label: 'Improved' };
  if (verified.some((e) => e.status === 'LIKELY_NOISE')) return { icon: '🟡', label: 'Likely noise' };
  return { icon: '✅', label: 'Passed' };
}

const NOISE_STATUSES = new Set<CheckStatus>(['LIKELY_NOISE', 'INCONCLUSIVE']);

/** Detail block heading + numbers + cause/explanation for one notable metric. */
function detailBlock(
  entry: CheckResultEntry,
  correlation: CorrelationResult | undefined,
  icon: string,
  aiPerMetric?: Record<string, string>,
): string[] {
  const lines: string[] = [];
  lines.push(`${icon} **${entry.metric}** — ${formatDeltaPercent(entry.deltaPercent)}`);
  lines.push('');
  lines.push(
    `Baseline: ${fmtMetricValue(entry.baselineMedian, entry.metric)} ` +
    `| Current: ${fmtMetricValue(entry.currentMedian, entry.metric)}`,
  );
  lines.push('');

  if (entry.status === 'IMPROVEMENT') {
    // Statistically certified improvement — show the evidence, no cause/AI.
    const evidence = [
      entry.pValue !== null ? `p=${entry.pValue.toFixed(4)}` : null,
      entry.effectSize !== null ? `d=${entry.effectSize.toFixed(2)}` : null,
      entry.effectZ !== null ? `effectZ=${entry.effectZ.toFixed(2)}` : null,
      entry.baselineCV !== null
        ? `baseline CV=${(entry.baselineCV * 100).toFixed(1)}%`
        : null,
    ].filter((x): x is string => x !== null);
    if (evidence.length > 0) {
      lines.push(`**Evidence:** ${evidence.join(', ')} — statistically supported improvement.`);
      lines.push('');
    }
    return lines;
  }

  if (NOISE_STATUSES.has(entry.status)) {
    lines.push(`**Why ${entry.status === 'INCONCLUSIVE' ? 'inconclusive' : 'likely noise'}:** ${entry.note ?? 'no deterministic reason recorded'}`);
    lines.push('');
    return lines;
  }

  // Regression or warning — deterministic cause first, then AI.
  lines.push(...causeLines(entry, correlation, aiPerMetric));
  return lines;
}

/** Baseline freshness/environment banner rendered right under the header. */
function baselineBanner(meta: BaselineMeta | undefined, aiUnavailable: boolean): string[] {
  const lines: string[] = [];
  if (!meta) return lines;
  if (meta.harness?.state === 'mismatch') {
    // A harness mismatch is not a caveat, it invalidates the comparison: the
    // two sides may collect different metrics and time them differently, so a
    // delta here describes the measuring code rather than the change.
    lines.push(
      `> ⛔ **Baseline was captured with a different PerfSense revision** (baseline ` +
        `\`${meta.harness.baselineRef ?? 'unknown'}\`, this run \`${meta.harness.runRef ?? 'unknown'}\`). ` +
        'Deltas below describe the two harnesses, not the code — every verdict is withheld. ' +
        'Re-capture the baseline on this revision to restore comparison.',
    );
  } else if (meta.harness?.state === 'unknown' && meta.harness.runRef && !meta.harness.baselineRef) {
    lines.push(
      '> ⚠ Baseline records no PerfSense revision, so comparability with this run cannot be ' +
        'established. Verdicts are still issued; re-capture the baseline to make them certifiable.',
    );
  }
  if (meta.hasEnv === false) {
    lines.push(
      '> ⚠ Baseline has no environment fingerprint (legacy v1). Improvement verdicts are ' +
      'not certified until a v2 baseline is captured; regressions below are flagged normally.',
    );
  }
  if (meta.envMatched === false && meta.hasEnv) {
    lines.push(
      '> ⚠ This run’s environment differs from the baseline. Improvements are demoted to ' +
      '“Likely noise” and flagged regressions may be runner noise — re-baseline on this runner to confirm.',
    );
  }
  if (meta.stale && meta.ageDays !== null) {
    lines.push(
      `> ⚠ Baseline is ${meta.ageDays} days old (outside the freshness window). Improvements are ` +
      'demoted to “Likely noise”; refresh the baseline to re-enable improvement verdicts.',
    );
  }
  if (aiUnavailable) {
    lines.push('> ⚠ AI unavailable — no provider/key configured. Deterministic causes still shown.');
  }
  if (lines.length > 0) lines.push('');
  return lines;
}

/** Contract section: Expected / Collected / Valid / Missing / Skipped / Compared. */
function contractSection(contract: ContractSummary | undefined, views: FixtureView[]): string[] {
  const lines: string[] = [];
  lines.push('## Contract');
  lines.push('');
  if (!contract) {
    lines.push('No contract data available.');
    lines.push('');
    return lines;
  }
  lines.push('| | Count |');
  lines.push('|---|---:|');
  lines.push(`| Expected (Benchmark Matrix) | ${contract.expected} |`);
  lines.push(`| Collected in this run | ${contract.collected} |`);
  lines.push(`| Valid (≥5 samples) | ${contract.valid} |`);
  lines.push(`| Missing baseline | ${contract.missing} |`);
  lines.push(`| Skipped | ${contract.skipped} |`);
  lines.push(`| Compared | ${contract.compared} |`);
  lines.push('');

  const notCompared = contract.rows.filter((r) => !r.compared && r.expected);
  if (notCompared.length > 0) {
    lines.push('**Not compared** (metrics that did not produce a verdict):');
    lines.push('');
    for (const row of notCompared) {
      const reason =
        row.skipped === 'no baseline'
          ? '⚫ no baseline'
          : row.skipped === 'no current samples'
            ? '⚫ no samples collected'
            : row.skipped === 'insufficient valid runs'
              ? '⚫ insufficient valid runs'
              : `⚫ ${row.skipped ?? 'skipped'}`;
      lines.push(`- \`${row.fixture}\` · \`${row.metric}\` — ${reason}`);
    }
    lines.push('');
  }
  if (views.length > 0 && notCompared.length === 0) {
    lines.push('Every approved metric was compared.');
    lines.push('');
  }
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
  const improvements = verified.filter((e) => e.status === 'IMPROVEMENT');
  const likelyNoise = verified.filter((e) => e.status === 'LIKELY_NOISE');

  const hasAI =
    !!options.aiAnalysis ||
    (options.aiPerMetric !== undefined && Object.keys(options.aiPerMetric).length > 0);
  const correlationHasExplanation =
    !!result.correlation &&
    (Object.values(result.correlation.metrics).some((mc) => mc.likelyCause) ||
      result.correlation.crossMetricCauses.length > 0);
  // "AI unavailable" only when there is something to explain and neither the
  // per-metric AI, the top-level AI section, nor a deterministic cause with a
  // rationale was produced — never a silent drop.
  const aiUnavailable =
    (regressions.length > 0 || warnings.length > 0) &&
    !hasAI &&
    !correlationHasExplanation;

  lines.push(...baselineBanner(result.baselineMeta, aiUnavailable));

  // ── Performance Check (overall status + fixture summary) ─────────────
  lines.push('## Performance Check');
  lines.push('');
  if (regressions.length > 0) {
    lines.push('🔴 Performance regression detected');
    lines.push('');
    lines.push(
      `${regressions.length} regression(s), ${warnings.length} warning(s), ` +
      `${improvements.length} improvement(s), ${likelyNoise.length} likely-noise change(s) across approved metrics.`,
    );
  } else if (warnings.length > 0) {
    lines.push('🟠 No hard regression (warnings present)');
    lines.push('');
    lines.push(
      `${warnings.length} warning(s), ${improvements.length} improvement(s), ` +
      `${likelyNoise.length} likely-noise change(s) — no metric exceeded its regression threshold.`,
    );
  } else {
    lines.push('🟢 No significant regression');
    if (improvements.length > 0 || likelyNoise.length > 0) {
      lines.push('');
      lines.push(
        `${improvements.length} statistically supported improvement(s) and ` +
        `${likelyNoise.length} likely-noise change(s) observed.`,
      );
    }
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

  // ── Details: notable regressions/warnings/improvements per fixture ────
  lines.push('## Details');
  lines.push('');
  let anyNotable = false;
  for (const view of views) {
    const notable = verifiedEntries(view).filter(
      (e) =>
        e.status === 'REGRESSION' ||
        e.status === 'WARNING' ||
        e.status === 'IMPROVEMENT' ||
        e.status === 'LIKELY_NOISE' ||
        e.status === 'INCONCLUSIVE',
    );
    if (notable.length === 0) continue;
    anyNotable = true;
    lines.push(`### ${view.displayName}`);
    lines.push('');
    for (const entry of notable) {
      const icon =
        entry.status === 'REGRESSION' ? '🔴'
          : entry.status === 'WARNING' ? '🟠'
            : entry.status === 'IMPROVEMENT' ? '🟢'
              : '🟡';
      lines.push(...detailBlock(entry, result.correlation, icon, options.aiPerMetric));
    }
  }
  if (!anyNotable) {
    lines.push('No regressions or meaningful changes detected.');
    lines.push('');
  }

  // ── Contract (coverage: nothing silently vanishes) ───────────────────
  lines.push(...contractSection(result.contract, views));

  // ── Full approved metrics (open by default) ───────────────────────────
  lines.push('<details open>');
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

  // ── AI Analysis (when available) ─────────────────────────────────────
  if (options.aiAnalysis && regressions.length > 0) {
    lines.push('<details>');
    lines.push('<summary>AI analysis</summary>');
    lines.push('');
    lines.push(options.aiAnalysis);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // ── Artifacts ────────────────────────────────────────────────────────
  lines.push('## Artifacts');
  lines.push('');
  lines.push('- [Full results JSON](./perfsense-results.json)');
  lines.push('');

  return lines.join('\n');
}