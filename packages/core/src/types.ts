export interface MetricMeta {
  unit: string;
  lowerIsBetter: boolean;
  type: "duration" | "score" | "count";
}

export interface MetricValue {
  name: string;
  value: number | null;
  meta: MetricMeta;
}

export interface BenchmarkRun {
  run: number;
  metrics: Record<string, number | null>;
}

export interface PageResult {
  page: string;
  runs: BenchmarkRun[];
}

export interface BenchmarkConfig {
  pages: string[];
  runs: number;
  settleMs: number;
  port: number;
  /** Optional interaction scenario applied to every page (keyed by page name when `fixtures` is set). */
  scenario?: string;
  /** Ordered interaction phases per page name. Each phase runs in sequence inside
   * one page so composites like "openProject then playToCompletion" work on a
   * single measured run. Takes precedence over `scenario` for pages that list one.
   */
  scenarios?: Record<string, string[]>;
  /** Fixture file name per page name, used by the openProject scenario. */
  fixtures?: Record<string, string>;
  /** Per-run wall-clock budget in ms (default 120000). */
  runTimeoutMs?: number;
  /**
   * Per-run wall-clock budget in ms for one page, overriding `runTimeoutMs`.
   * Keyed by page name, the same way `fixtures` and `scenarios` are.
   *
   * This exists because the budget has two independent consumers -- the
   * scenario phase and the whole-run race -- and the pages need very different
   * amounts of it. musical-tree runs its program twelve times (twice inside
   * playToCompletion, then `repeatRuns`), which measures 289s of scenario work
   * against a 300s global budget; every run was being skipped as a timeout. A
   * global raise would give that slack to pages that do not need it and hide
   * genuine hangs on the fast ones.
   */
  runTimeouts?: Record<string, number>;
  /**
   * Scroll-key steps the `interact` scenario issues to pan the workspace
   * (default 24). Each step moves the blocks container by half a canvas
   * height, so the workspace is traversed end to end.
   */
  panSteps?: number;
  /** Pause after each pan step in ms (default 120). Lets the rAF loop paint. */
  panSettleMs?: number;
  /**
   * Runs the `repeatedRun` scenario performs inside one page load
   * (default 10). Bounded by runTimeoutMs.
   */
  repeatRuns?: number;
}

export interface BaselineMetricStats {
  median: number;
  p10: number;
  p90: number;
  values: number[];
}

/** Baseline distribution stats written by `baseline save` (schema v2). */
export interface BaselineMetricStatsV2 extends BaselineMetricStats {
  mean: number;
  sd: number;
  mad: number;
  min: number;
  max: number;
  p25: number;
  p75: number;
  /** Coefficient of variation (sd / mean), the metric-level stability signal. */
  cv: number;
  /** Number of valid samples used to compute the stats. */
  n: number;
  invalid: number;
  stability: { tier: StabilityTier; flagged: boolean; note?: string };
}

export type StabilityTier = "stable" | "moderate" | "high" | "extreme";

export interface BaselinePage {
  [metricName: string]: BaselineMetricStatsV2;
}

/** cgroup CPU quota, the signal that distinguishes a busy runner from a slow change. */
export interface CpuThrottle {
  /** Quota expressed in cores (cgroup v2 `cpu.max`, or v1 quota/period). Null when unrestricted or unreadable. */
  quotaCpus: number | null;
  /** True when the quota is below the visible core count. Null when the quota is unknown. */
  throttled: boolean | null;
  /** Where the numbers came from, for auditability. */
  source: "cgroup-v2" | "cgroup-v1" | "unavailable";
}

/** Environment fingerprint used for the baseline↔current environment gate. */
export interface EnvironmentFingerprint {
  os: string;
  arch: string;
  node: string;
  cpu: string;
  cores: number;
  memoryGB: number;
  runner?: string;
  coldState: boolean;
  /** 1-minute load average at capture time. Omitted where the platform does not report it. */
  loadAvg1m?: number;
  /** CPU quota of the current cgroup. Omitted when it cannot be read. */
  cpuQuota?: CpuThrottle;
}

/**
 * Which PerfSense revision produced a baseline. Recorded so a comparison can
 * refuse to run across two different harnesses: the two sides can collect
 * different metric sets and measure the same metric differently, so a delta
 * between them is not a measurement of the code.
 */
export type BaselineHarness =
  | { ref: string; source: "PERFSENSE_REF" }
  /** Captured outside the workflow, so the revision is genuinely unknown — not the same as "old harness". */
  | { ref: null; source: "unavailable"; reason: string };

export interface BaselineData {
  schema: string;
  /** 1 for the legacy shape, 2 for the distribution-stats + env shape. */
  schemaVersion?: number;
  createdAt: string;
  generatedAt?: string;
  commitSHA?: string;
  /**
   * Alias written by the baseline stamp step in the capture workflow (it
   * rewrites the file after `baseline save` to attach runner metadata).
   * `commitSHA` is the canonical key and the one `baseline save` writes;
   * readers accept this alias so a stamped file still compares commits.
   */
  commitSha?: string;
  perfsenseSHA?: string;
  configHash?: string;
  /** PerfSense revision that produced this baseline. Absent on legacy baselines. */
  harness?: BaselineHarness;
  runs: number;
  warmup?: number;
  env?: EnvironmentFingerprint;
  pages: Record<string, BaselinePage>;
  source: string;
}

/** Why a baseline capture was rejected or flagged. */
export type BaselineDefectKind =
  | "bimodal"
  | "spread"
  | "divergence"
  | "below-resolution"
  | "zero-variance"
  | "insufficient-samples"
  | "orphan-cell"
  | "missing-metric"
  | "missing-fixture";

export interface BaselineDefect {
  fixture: string;
  /** Null for fixture-level defects (a whole fixture missing). */
  metric: string | null;
  kind: BaselineDefectKind;
  /** `fail` blocks the baseline commit; `warn` is reported for human judgement. */
  severity: "fail" | "warn";
  detail: string;
}

export interface BaselineValidity {
  /** True when no defect has `fail` severity. */
  ok: boolean;
  defects: BaselineDefect[];
  /** True when a previous baseline was supplied and compared against. */
  comparedWithPrevious: boolean;
  fixtureCount: number;
  metricCount: number;
}

export interface ThresholdLevel {
  warning: number;
  fail: number;
  /**
   * Optional ceiling status applied after classification: 'warning' caps
   * REGRESSION at WARNING, 'pass' caps everything at PASS. Used for metrics
   * whose probes are warn-only until their variance is characterized.
   */
  maxStatus?: "pass" | "warning";
}

/**
 * Thresholds for `perfsense baseline validate`. Every limit is explicit by
 * design: a metric with no configured spread limit is reported as unconfigured
 * rather than passed or failed against a blanket default, so the gate can never
 * silently approve noise or block on a wrong number.
 */
export interface ValidityConfig {
  /** Max `(p90 - p10) / median` as a percentage, per metric name. */
  maxSpreadPct?: Record<string, number>;
  /** Max median movement against the previous baseline, percent, when the fixture hashes are unchanged. */
  maxDivergencePct?: number;
  /** Largest-consecutive-gap / median-of-other-gaps ratio that counts as two clusters. */
  bimodalGapRatio?: number;
  /** Median shift between the two clusters that counts as bimodal, percent. */
  bimodalShiftPct?: number;
  /** Metrics whose median sits below this cannot resolve a real change. */
  resolutionFloor?: number;
  /** Minimum valid samples per metric cell. */
  minSamples?: number;
  /** Reject a capture taken on a runner reporting a CPU quota below its core count. */
  rejectThrottled?: boolean;
}

export interface PerfSenseConfig {
  thresholds: Record<string, ThresholdLevel>;
  validity?: ValidityConfig;
}

export type CheckStatus =
  | "PASS"
  | "WARNING"
  | "REGRESSION"
  | "IMPROVEMENT"
  | "LIKELY_NOISE"
  | "NO_BASELINE"
  | "CHANGED"
  | "INCONCLUSIVE";

export interface MetricCheckResult {
  page: string;
  metric: string;
  status: CheckStatus;
  deltaPercent: number;
  failThreshold: number;
  baselineMedian: number;
  currentMedian: number;
}

/** Per-metric coverage row for the report's Contract section. */
export interface ContractRow {
  fixture: string;
  metric: string;
  /** Approved by the Benchmark Matrix for this fixture. */
  expected: boolean;
  /** Appeared in the current results with at least one numeric value. */
  collected: boolean;
  /** Collected with a sufficient number of valid current samples. */
  valid: boolean;
  /** Approved + collected, but the baseline lacks an entry for it. */
  baselineMissing: boolean;
  /** Produced a real comparison (baseline present + collected + classified). */
  compared: boolean;
  /** Machine-readable reason when the metric was not compared. */
  skipped: string | null;
}

export interface ContractSummary {
  rows: ContractRow[];
  expected: number;
  collected: number;
  valid: number;
  missing: number;
  skipped: number;
  compared: number;
}

export interface EvidenceHighlight {
  label: string;
  value: string;
  severity: "info" | "warning" | "critical";
}

export interface Evidence {
  id: string;
  type: "trace" | "network" | "git-diff";
  metricName: string;
  timestamp: number;
  confidence: number;
  summary: string;
  highlights: EvidenceHighlight[];
  details?: unknown;
}
