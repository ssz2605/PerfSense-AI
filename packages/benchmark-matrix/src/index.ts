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
  /**
   * Fingerprint metrics, compared for equality rather than for improvement.
   *
   * These are deterministic counters that stand in for one optimization: the
   * healthy build produces a fixed value, and editing or reverting the optimized
   * code path changes it. That makes a signed-delta comparison the wrong tool in
   * both directions — a percentage says nothing about whether a code path is
   * still wired, and for a counter that must not fall, a drop reads as an
   * improvement.
   *
   * An exact cell reports CHANGED when |current - baseline| exceeds its
   * tolerance, whichever way the value moved.
   */
  exactMetrics?: string[];
  /**
   * Per-cell tolerance for exact metrics, in the metric's own unit. Defaults to
   * 0, which is correct for integer counters that must be bit-identical.
   */
  exactTolerance?: Record<string, number>;
  /**
   * Metrics whose cell must exist in every capture. If an approved-and-required
   * metric is null (or absent) on all runs of its fixture, the run is a failure
   * rather than a silent omission: "no data" must never be reported as "no
   * change" for a metric that exists to prove an optimization is still in place.
   */
  requiredMetrics?: string[];
}

/** Tolerance for an exact cell when the contract does not state one. */
export const DEFAULT_EXACT_TOLERANCE = 0;

export const BENCHMARK_MATRIX: FixtureContract[] = [
  {
    fixture: "index.html",
    displayName: "index.html (bootstrap)",
    metrics: ["bootstrapTotal", "initTotal", "heapAfterBoot"],
    unverified: [],
    warnOnly: [],
  },
  {
    fixture: "RainbowConnection.html",
    displayName: "Rainbow Connection",
    // refreshCanvasCallCount is the direct read on PR #7923: with
    // _suppressRefresh set, refreshCanvas() returns early during decode and
    // the load repaints almost nothing. Best-guess timing (projectLoadTime)
    // only sees the side effect.
    // peakHeapDuringExport covers the memory half of PR #7970, which bought a
    // ~23x export speedup with a documented ~1.3 MB -> ~27 MB peak and had no
    // cell watching it. maxDepth is back for the same PR: the fast-run path
    // raises execution depth 1 -> 100, and driver.ts filters unapproved metrics
    // at the collection boundary, so it was not being measured at all.
    //
    // Removed (2026-10): exportMIDITime, saveAsLilypondTime, stageUpdateCallCount,
    // stageUpdateTime, stageUpdateMax, cacheRebuildCount, viewportCulledBlocks.
    // None of them is a witness for any merged perf PR on this fixture, and a
    // cell that only ever reports NO_BASELINE or a warn-only delta is a row a
    // reviewer learns to skip. The two that stay are the ones whose value
    // CHANGES when the optimized path is reverted.
    metrics: [
      "projectLoadTime",
      "saveTime",
      "refreshCanvasCallCount",
      "peakHeapDuringExport",
      "maxDepth",
    ],
    unverified: [],
    // #7923 + #7970's witnesses, exact: the healthy build records
    // deterministic values for both, and reverting either PR moves its cell.
    exactMetrics: ["refreshCanvasCallCount", "maxDepth"],
    requiredMetrics: ["refreshCanvasCallCount", "maxDepth"],
    // Nothing on this fixture is warn-only any more: every remaining cell is
    // either an exact fingerprint or a timing metric with a real threshold.
    warnOnly: [],
  },
  {
    fixture: "Frere-Jacques.html",
    displayName: "Frère Jacques",
    // Voice-timing only. The interpreter counters that used to sit here
    // (scheduleCount, executionTime, blocksExecuted, maxQueueDepth) are still
    // collected, but they are not part of the regression contract: blocksExecuted
    // is bit-identical run to run on unchanged code, and maxQueueDepth swings
    // 21–25 while doing so, so neither can serve as a reference distribution.
    // A metric that varies under identical conditions cannot detect a change.
    //
    // transportEventRatio / transportEventCount / synthsRetained are event
    // counts, not costs, and they are the only audio-family cells that work on
    // a synthesised clock: neither depends on how accurate the clock is.
    // cumulativeDrift is removed from the contract (2026-10): it collapses to
    // ~1e-9 ms headless and cannot see a regression in either direction.
    metrics: [
      "callbackLatencyMean",
      "callbackLatencyMax",
      "voiceOnsetError",
      "transportEventRatio",
      "transportEventCount",
      "synthsRetained",
    ],
    unverified: [],
    // PR #7703's witnesses. Both count delays that took the Tone.Transport
    // branch instead of the setTimeout fallback, so a revert drives them to 0
    // (ratio) or near 0 (count). Neither is a cost, so neither has a meaningful
    // "better" direction: they are compared for equality. transportEventCount
    // is the numerator the ratio is computed from, so it stays put even if an
    // unrelated scheduler inflates the denominator.
    exactMetrics: [
      "transportEventRatio",
      "transportEventCount",
      "synthsRetained",
    ],
    // The ratio is derived from two counters and is serialized as a float.
    // This epsilon accepts insignificant representation noise, not a change
    // to the ~0.0253 transport share.
    exactTolerance: { transportEventRatio: 0.0001 },
    // Required: these cells exist to prove the seam is still wired, so a null
    // reading is a broken collector, not an unchanged build.
    requiredMetrics: ["transportEventRatio", "transportEventCount"],
    // synthsRetained is PR #7832's fingerprint; it is exact too but not
    // required, because the healthy value is 0 and that is also what a
    // collector failure would produce.
    // The four timing cells stay warn-only: their CI variance is not yet
    // characterized, so they can warn but must not post a hard REGRESSION.
    warnOnly: [
      "callbackLatencyMean",
      "callbackLatencyMax",
      "voiceOnsetError",
    ],
  },
  {
    fixture: "musical-tree.html",
    displayName: "musical-tree",
    // maxLogicalDepth was dropped from the contract for the same reason as
    // Frère's interpreter counters: it never produced a usable baseline cell.
    //
    // The repeated-run cells are PR #7848's invariants: a natural completion
    // preserves the drawing (canvasInkCoverage > 0) and N completions do not
    // accumulate ink (canvasInkDrift ~ 0).
    //
    // Removed (2026-10): memoryDelta, retainedHeap, retainedHeapSlope.
    // memoryDelta/retainedHeap are the old two-run endpoint probes and read
    // exactly 0 without --enable-precise-memory-info; retainedHeapSlope is a
    // heap measurement whose CI spread is not characterized, so it could only
    // ever warn. #7848 keeps its two canvas invariants, which are the ones a
    // re-wired cleanup actually moves.
    //
    // Removed (2026-10): maxQueueDepth. It protects none of the seven merged
    // perf PRs, and at a median near 8 its own quantization floor (2 units =
    // 25%) sits above the 20% limit configured for it, so it is the likeliest
    // remaining cell to fail baseline validate on nothing but rounding. The
    // collector still exists and still reports; it is simply not a gate.
    metrics: ["executionTime", "canvasInkCoverage", "canvasInkDrift", "synthsRetained"],
    // #7848's invariants as exact fingerprints: inkCoverage ~constant and
    // inkDrift ~0 on a healthy build, and both collapse to 0 / grow when
    // cleanup is re-wired to clear the drawing.
    exactMetrics: ["canvasInkCoverage", "canvasInkDrift", "synthsRetained"],
    // Canvas coverage/drift are pixel-derived floating point measurements.
    // Counters retain the default exact (zero) tolerance.
    exactTolerance: {
      canvasInkCoverage: 0.0001,
      canvasInkDrift: 0.000001,
    },
    requiredMetrics: [
      "canvasInkCoverage",
      "canvasInkDrift",
      "synthsRetained",
    ],
    // Memory is gone from this fixture entirely, so there is nothing left to
    // cap: the two remaining timing metrics carry real thresholds.
    warnOnly: [],
  },
  {
    fixture: "ascending-notes-color-spiral.html",
    displayName: "ascending-notes-color-spiral",
    // maxLogicalDepth removed from the contract (see Frère Jacques above).
    metrics: ["executionTime", "blocksExecuted"],
    warnOnly: [],
  },
  {
    fixture: "crabcanon-plot.html",
    displayName: "crabcanon-plot",
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
    // The render cells are PR #7738's coverage and PR #7815's cost.
    // viewportCulledBlocks / viewportCulledFraction are the direct state read
    // of the culler; cacheRebuildCount / cacheSkippedCount are the direct read
    // of the off-screen updateCache guard.
    //
    // Removed (2026-10): stageUpdateTime, stageUpdateMax. They are the cost
    // side of #7738 (stage.update 4.807 ms -> 1.972 ms), but their observed
    // CI spread is exactly what failed baseline validate: a per-frame duration
    // distribution on a loaded runner is bimodal, and a bimodal sample is a
    // hard fail rather than a warning. Losing them costs the "is the win still
    // there in milliseconds" reading; the four counters below still fail loudly
    // when the same code is reverted.
    metrics: [
      "cacheRebuildCount",
      "cacheSkippedCount",
      "viewportCulledBlocks",
      "viewportCulledFraction",
      "transportEventRatio",
    ],
    unverified: [],
    // #7738 / #7815 as exact fingerprints: culling state and the skipped
    // cache rebuilds are deterministic on an unchanged build, and each
    // collapses the other way when its PR is reverted. Required: a null
    // reading means the collector broke, not that the state was neutral.
    exactMetrics: [
      "cacheRebuildCount",
      "cacheSkippedCount",
      "viewportCulledBlocks",
      "viewportCulledFraction",
    ],
    // Fraction is maxCulled/blockTotal and therefore subject only to float
    // representation noise; all count fingerprints remain bit-identical.
    exactTolerance: { viewportCulledFraction: 0.0001 },
    requiredMetrics: [
      "cacheRebuildCount",
      "cacheSkippedCount",
      "viewportCulledBlocks",
      "viewportCulledFraction",
    ],
    warnOnly: ["transportEventRatio"],
  },
];

/** Presentation units used to format metric values in the report. */
const METRIC_UNITS: Record<string, string> = {
  bootstrapTotal: "ms",
  initTotal: "ms",
  heapAfterBoot: "MB",
  projectLoadTime: "ms",
  saveTime: "ms",
  exportMIDITime: "ms",
  saveAsLilypondTime: "ms",
  memoryDelta: "B",
  retainedHeap: "B",
  callbackLatencyMean: "ms",
  callbackLatencyMax: "ms",
  cumulativeDrift: "ms",
  voiceOnsetError: "ms",
  scheduleLagMean: "ms",
  scheduleLagMax: "ms",
  executionTime: "ms",
  maxQueueDepth: "count",
  maxLogicalDepth: "count",
  scheduleCount: "count",
  blocksExecuted: "count",
  maxDepth: "count",
  stageUpdateTime: "ms",
  stageUpdateMax: "ms",
  stageUpdateCallCount: "count",
  cacheRebuildCount: "count",
  viewportCulledBlocks: "count",
  cacheSkippedCount: "count",
  viewportCulledFraction: "ratio",
  refreshCanvasCallCount: "count",
  transportEventRatio: "ratio",
  transportEventCount: "count",
  synthsRetained: "count",
  logoSoundsRetained: "count",
  canvasInkCoverage: "ratio",
  canvasInkDrift: "ratio",
  retainedHeapSlope: "B/run",
  peakHeapDuringExport: "B",
};

/** Case-insensitive fixture lookup. */
export function getFixtureContract(
  fixture: string,
): FixtureContract | undefined {
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

/**
 * True when the metric is a fingerprint: compared for equality, not for
 * improvement. Every metric not listed keeps the historical signed-delta
 * behaviour.
 */
export function isMetricExact(fixture: string, metric: string): boolean {
  const contract = getFixtureContract(fixture);
  if (!contract) return false;
  const key = metric.toLowerCase();
  return (contract.exactMetrics ?? []).some((m) => m.toLowerCase() === key);
}

/**
 * Allowed |current - baseline| for an exact cell before it counts as CHANGED.
 * 0 for integer counters, so only a bit-identical value passes.
 */
export function getExactTolerance(fixture: string, metric: string): number {
  const contract = getFixtureContract(fixture);
  if (!contract) return DEFAULT_EXACT_TOLERANCE;
  const table = contract.exactTolerance ?? {};
  const match = Object.keys(table).find(
    (k) => k.toLowerCase() === metric.toLowerCase(),
  );
  return match !== undefined ? table[match] : DEFAULT_EXACT_TOLERANCE;
}

/**
 * True when the metric's absence must be treated as a failure rather than a
 * skipped row. Only meaningful for metrics that are also approved.
 */
export function isMetricRequired(fixture: string, metric: string): boolean {
  const contract = getFixtureContract(fixture);
  if (!contract) return false;
  const key = metric.toLowerCase();
  return (contract.requiredMetrics ?? []).some((m) => m.toLowerCase() === key);
}

/** Human-friendly fixture heading (falls back to the raw fixture key). */
export function formatFixtureName(fixture: string): string {
  const contract = getFixtureContract(fixture);
  return contract ? contract.displayName : fixture;
}

/** Unit used to format a metric value (defaults to ms). */
export function getMetricUnit(metric: string): string {
  return METRIC_UNITS[metric] ?? "ms";
}

/** Formats a raw metric value with its unit for the report table. */
export function formatMetricValue(value: number, metric: string): string {
  const unit = getMetricUnit(metric);
  if (unit === "B") return `${value.toFixed(0)} B`;
  // Heap values are captured in bytes but presented in MB.
  if (unit === "MB") return `${(value / 1e6).toFixed(1)} MB`;
  if (unit === "count") return `${value.toFixed(0)}`;
  // Unitless ratios read better as a percentage: a floor like
  // transportEventRatio is 1.0 healthy, and ink coverage is a canvas fraction.
  if (unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  if (unit === "B/run") return `${value.toFixed(0)} B/run`;
  return `${value.toFixed(1)} ms`;
}

/** Formats a delta percentage with sign, e.g. +159.4%. Null (near-zero) renders as '—'. */
export function formatDeltaPercent(deltaPercent: number | null): string {
  if (deltaPercent === null || !isFinite(deltaPercent)) return "—";
  const sign = deltaPercent >= 0 ? "+" : "";
  return `${sign}${deltaPercent.toFixed(1)}%`;
}
