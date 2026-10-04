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
    // stageUpdateCallCount is the direct read on PR #7923: with
    // _suppressRefresh set, refreshCanvas() returns early, stageDirty is never
    // raised during decode and the render loop goes idle, so the load paints
    // almost nothing. projectLoadTime only sees the side effect.
    // peakHeapDuringExport covers the memory half of PR #7970, which bought a
    // ~23x export speedup with a documented ~1.3 MB -> ~27 MB peak and had no
    // cell watching it. maxDepth is back for the same PR: the fast-run path
    // raises execution depth 1 -> 100, and driver.ts filters unapproved metrics
    // at the collection boundary, so it was not being measured at all.
    // logoSoundsRetained is a floor, not a cost: RainbowConnection is the one
    // fixture whose program plays sound blocks (MediaBlocks.js:554), so this is
    // where PR #7832's cleanup is observable.
    metrics: [
      'projectLoadTime',
      'saveTime',
      'exportMIDITime',
      'saveAsLilypondTime',
      'stageUpdateCallCount',
      'peakHeapDuringExport',
      'maxDepth',
      'logoSoundsRetained',
      'stageUpdateTime',
      'stageUpdateMax',
      'cacheRebuildCount',
      'viewportCulledBlocks',
    ],
    unverified: ['maxDepth'],
    warnOnly: [
      'maxDepth',
      'stageUpdateTime',
      'stageUpdateMax',
      'cacheRebuildCount',
      'viewportCulledBlocks',
    ],
  },
  {
    fixture: 'Frere-Jacques.html',
    displayName: 'Frère Jacques',
    // Voice-timing only. The interpreter counters that used to sit here
    // (scheduleCount, executionTime, blocksExecuted, maxQueueDepth) are still
    // collected, but they are not part of the regression contract: blocksExecuted
    // is bit-identical run to run on unchanged code, and maxQueueDepth swings
    // 21–25 while doing so, so neither can serve as a reference distribution.
    // A metric that varies under identical conditions cannot detect a change.
    //
    // transportEventRatio and synthsRetained are floor asserts, not costs, and
    // they are the only two audio-family cells that work on a synthesised
    // clock: both are counts of events, so neither depends on how accurate the
    // clock is. cumulativeDrift collapses to ~1e-9 ms headless and cannot see a
    // regression at all.
    metrics: [
      'callbackLatencyMean',
      'callbackLatencyMax',
      'cumulativeDrift',
      'voiceOnsetError',
      'transportEventRatio',
      'synthsRetained',
    ],
    unverified: [],
    // The ratio is a floor (higher is better), so it is gated from below: a
    // drop means scheduling left the transport seam. Everything else here is
    // warn-only for the existing reason.
    warnOnly: [
      'callbackLatencyMean',
      'callbackLatencyMax',
      'cumulativeDrift',
      'voiceOnsetError',
      'transportEventRatio',
      'synthsRetained',
    ],
  },
  {
    fixture: 'musical-tree.html',
    displayName: 'musical-tree',
    // maxLogicalDepth was dropped from the contract for the same reason as
    // Frère's interpreter counters: it never produced a usable baseline cell.
    // The repeated-run cells are PR #7848's invariants: a natural completion
    // preserves the drawing (canvasInkCoverage > 0), N completions do not
    // accumulate ink (canvasInkDrift ~ 0) and do not retain heap
    // (retainedHeapSlope ~ 0). memoryDelta/retainedHeap are the old two-run
    // endpoint probes; they read exactly 0 without --enable-precise-memory-info
    // and stay for continuity only.
    metrics: [
      'maxQueueDepth',
      'executionTime',
      'memoryDelta',
      'retainedHeap',
      'canvasInkCoverage',
      'canvasInkDrift',
      'retainedHeapSlope',
      'synthsRetained',
    ],
    // Memory stays warn-only (real values now, but CI-heap noise is hard to
    // characterize): it can warn but never post a hard REGRESSION.
    warnOnly: [
      'memoryDelta',
      'retainedHeap',
      'canvasInkCoverage',
      'canvasInkDrift',
      'retainedHeapSlope',
      'synthsRetained',
    ],
  },
  {
    fixture: 'ascending-notes-color-spiral.html',
    displayName: 'ascending-notes-color-spiral',
    // maxLogicalDepth removed from the contract (see Frère Jacques above).
    metrics: ['executionTime', 'blocksExecuted'],
    warnOnly: [],
  },
  {
    fixture: 'crabcanon-plot.html',
    displayName: 'crabcanon-plot',
    // executionTime, blocksExecuted and maxQueueDepth are collected but not
    // part of the contract: blocksExecuted is deterministic and therefore
    // inert, and maxQueueDepth is not reproducible on this fixture (10,10,8,8,8
    // across five runs of unchanged code).
    //
    // scheduleLagMean/scheduleLagMax were removed from this fixture: at
    // ~1e-11 ms they sit below timer resolution, so they are constant on
    // unchanged code and cannot serve as a reference distribution. The
    // contract drops them; driver.ts still collects them (they are requested in
    // perfsense.config.json) so the continuity read survives in the raw results.
    //
    // The render cells are PR #7738's coverage. This is the fixture the
    // optimisation was measured on (stage.update 4.807 ms -> 1.972 ms) and the
    // config previously had no render metric whatsoever, so the change was
    // unobservable in both directions. viewportCulledBlocks is the direct
    // state read; stageUpdateTime/Max are the cost it buys; cacheRebuildCount
    // is PR #7815's cost.
    metrics: [
      'stageUpdateTime',
      'stageUpdateMax',
      'cacheRebuildCount',
      'viewportCulledBlocks',
      'transportEventRatio',
    ],
    unverified: [],
    // The lag probes stay warn-only: at ~1e-11 ms they sit below timer
    // resolution, so they can inform but never fail a PR on their own. The
    // render cells start warn-only too — they are new and their CI spread is
    // not yet characterised across many baseline captures.
    warnOnly: [
      'stageUpdateTime',
      'stageUpdateMax',
      'cacheRebuildCount',
      'viewportCulledBlocks',
      'transportEventRatio',
    ],
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
  saveAsLilypondTime: 'ms',
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
  maxLogicalDepth: 'count',
  scheduleCount: 'count',
  blocksExecuted: 'count',
  maxDepth: 'count',
  stageUpdateTime: 'ms',
  stageUpdateMax: 'ms',
  stageUpdateCallCount: 'count',
  cacheRebuildCount: 'count',
  viewportCulledBlocks: 'count',
  transportEventRatio: 'ratio',
  synthsRetained: 'count',
  logoSoundsRetained: 'count',
  canvasInkCoverage: 'ratio',
  canvasInkDrift: 'ratio',
  retainedHeapSlope: 'B/run',
  peakHeapDuringExport: 'B',
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
  // Unitless ratios read better as a percentage: a floor like
  // transportEventRatio is 1.0 healthy, and ink coverage is a canvas fraction.
  if (unit === 'ratio') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'B/run') return `${value.toFixed(0)} B/run`;
  return `${value.toFixed(1)} ms`;
}

/** Formats a delta percentage with sign, e.g. +159.4%. Null (near-zero) renders as '—'. */
export function formatDeltaPercent(deltaPercent: number | null): string {
  if (deltaPercent === null || !isFinite(deltaPercent)) return '—';
  const sign = deltaPercent >= 0 ? '+' : '';
  return `${sign}${deltaPercent.toFixed(1)}%`;
}