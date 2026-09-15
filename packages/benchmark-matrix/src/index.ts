/**
 * Music Blocks Benchmark Matrix — the source of truth for which metrics are
 * approved for each benchmark fixture.
 *
 * This contract drives the presentation/filtering layer only. The benchmark
 * system may continue to collect every metric it needs; nothing here deletes
 * raw data. The report simply refuses to show metric/fixture combinations
 * that are not part of the approved matrix.
 *
 * Changing this file IS how the benchmark contract is changed.
 */

export interface FixtureContract {
  /** Page/fixture key as it appears in benchmark results (PageResult.page). */
  fixture: string;
  /** Human-friendly section heading used in the report. */
  displayName: string;
  /** Metrics approved by the Benchmark Matrix for this fixture. */
  metrics: string[];
  /**
   * Metrics that are still sanity/unverified. They may be shown in the summary
   * but their status reads "Unverified" and they are never treated as genuine
   * performance regressions.
   */
  unverified?: string[];
  /**
   * Warn-only metrics. They are analyzed and shown, but their status is capped
   * at warning: they can never post REGRESSION. Initial rollout for metrics
   * whose CI variance is not yet characterized.
   */
  warnOnly?: string[];
}

export const BENCHMARK_MATRIX: FixtureContract[] = [
  // ── maxDepth status (sanity/unverified) ──────────────────────────────
  // The maxDepth probe currently wraps `logo.runFromBlockNow` and records the
  // peak synchronous JS-call nesting of that single interpreter function, NOT
  // logical (program-level) action recursion:
  //   * flat sequential programs recurse one JS frame per flow step up to the
  //     interpreter's yield cap (~1000), so maxDepth tracks interpreter stack
  //     growth, not program structure;
  //   * logical recursion via do/doArg/action stacks is realized ITERATIVELY
  //     through the turtle queue (visible in maxQueueDepth), so it never adds
  //     runFromBlockNow nesting;
  //   * value-expression nesting (parseArg) never enters runFromBlockNow.
  // Correct instrumentation for a logical recursion-depth metric must count
  // logical action entry/exit in the app's action engine (increment on nested
  // action call, decrement on completion/return, exception-safe, reset per
  // measured run). TODO(implementation boundary): implement that app-side seam
  // before treating maxDepth as a reliable regression signal; until then the
  // report renders it as "Unverified" and never as a regression.
  {
    fixture: 'index.html',
    displayName: 'index.html (bootstrap)',
    metrics: ['bootstrapTotal', 'initTotal', 'heapAfterBoot'],
    unverified: [],
    warnOnly: [],
  },
  {
    fixture: 'RainbowConnection.html',
    displayName: 'Rainbow Connection',
    metrics: ['projectLoadTime', 'saveTime', 'exportMIDITime', 'memoryDelta', 'retainedHeap'],
    unverified: [],
    warnOnly: ['memoryDelta', 'retainedHeap'],
  },
  {
    fixture: 'Frere-Jacques.html',
    displayName: 'Frère Jacques',
    metrics: ['callbackLatencyMean', 'callbackLatencyMax', 'cumulativeDrift', 'voiceOnsetError'],
    unverified: [],
    warnOnly: ['callbackLatencyMean', 'callbackLatencyMax', 'cumulativeDrift', 'voiceOnsetError'],
  },
  {
    fixture: 'musical-tree.html',
    displayName: 'musical-tree',
    metrics: ['maxQueueDepth', 'executionTime', 'memoryDelta', 'retainedHeap', 'maxDepth'],
    // maxDepth is suspected to measure runFromBlockNow() nesting rather than
    // logical action recursion and is currently sanity/unverified.
    unverified: ['maxDepth'],
    warnOnly: ['memoryDelta', 'retainedHeap'],
  },
  {
    fixture: 'ascending-notes-color-spiral.html',
    displayName: 'ascending-notes-color-spiral',
    metrics: ['executionTime', 'maxDepth', 'blocksExecuted'],
    unverified: ['maxDepth'],
    warnOnly: [],
  },
  {
    fixture: 'crabcanon-plot.html',
    displayName: 'crabcanon-plot',
    metrics: ['scheduleLagMean', 'scheduleLagMax'],
    unverified: [],
    warnOnly: [],
  },
];

/** Presentation units used to format metric values in the report. */
const METRIC_UNITS: Record<string, string> = {
  bootstrapTotal: 'ms',
  initTotal: 'ms',
  heapAfterBoot: 'MB',
  projectLoadTime: 'ms',
  saveTime: 'ms',
  exportMIDITime: 'ms',
  memoryDelta: 'B',
  retainedHeap: 'B',
  callbackLatencyMean: 'ms',
  callbackLatencyMax: 'ms',
  cumulativeDrift: 'ms',
  voiceOnsetError: 'ms',
  scheduleLagMean: 'ms',
  scheduleLagMax: 'ms',
  executionTime: 'ms',
  maxQueueDepth: 'count',
  maxDepth: 'count',
  blocksExecuted: 'count',
};

/** Case-insensitive fixture lookup. */
export function getFixtureContract(fixture: string): FixtureContract | undefined {
  const key = fixture.toLowerCase();
  return BENCHMARK_MATRIX.find((c) => c.fixture.toLowerCase() === key);
}

/** True when the fixture is part of the approved Benchmark Matrix. */
export function isKnownFixture(fixture: string): boolean {
  return getFixtureContract(fixture) !== undefined;
}

/** Metrics approved for a fixture (case-insensitive metric name match). */
export function getApprovedMetrics(fixture: string): string[] {
  const contract = getFixtureContract(fixture);
  return contract ? contract.metrics : [];
}

/** True when the metric is part of the approved matrix for the fixture. */
export function isMetricApproved(fixture: string, metric: string): boolean {
  const contract = getFixtureContract(fixture);
  if (!contract) return false;
  const key = metric.toLowerCase();
  return contract.metrics.some((m) => m.toLowerCase() === key);
}

/** True when the metric is approved but still marked sanity/unverified. */
export function isMetricUnverified(fixture: string, metric: string): boolean {
  const contract = getFixtureContract(fixture);
  if (!contract) return false;
  const key = metric.toLowerCase();
  return (contract.unverified ?? []).some((m) => m.toLowerCase() === key);
}

/**
 * True when the metric is approved but warn-only: analyzed and shown, yet
 * capped at WARNING so it can never post REGRESSION.
 */
export function isMetricWarnOnly(fixture: string, metric: string): boolean {
  const contract = getFixtureContract(fixture);
  if (!contract) return false;
  const key = metric.toLowerCase();
  return (contract.warnOnly ?? []).some((m) => m.toLowerCase() === key);
}

/** Human-friendly fixture heading (falls back to the raw fixture key). */
export function formatFixtureName(fixture: string): string {
  const contract = getFixtureContract(fixture);
  return contract ? contract.displayName : fixture;
}

/** Unit used to format a metric value (defaults to ms). */
export function getMetricUnit(metric: string): string {
  return METRIC_UNITS[metric] ?? 'ms';
}

/** Formats a raw metric value with its unit for the report table. */
export function formatMetricValue(value: number, metric: string): string {
  const unit = getMetricUnit(metric);
  if (unit === 'B') return `${value.toFixed(0)} B`;
  // Heap values are captured in bytes but presented in MB.
  if (unit === 'MB') return `${(value / 1e6).toFixed(1)} MB`;
  if (unit === 'count') return `${value.toFixed(0)}`;
  return `${value.toFixed(1)} ms`;
}

/** Formats a delta percentage with sign, e.g. +159.4%. */
export function formatDeltaPercent(deltaPercent: number): string {
  const sign = deltaPercent >= 0 ? '+' : '';
  return `${sign}${deltaPercent.toFixed(1)}%`;
}