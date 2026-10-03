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
}

export interface BaselineData {
  schema: string;
  /** 1 for the legacy shape, 2 for the distribution-stats + env shape. */
  schemaVersion?: number;
  createdAt: string;
  generatedAt?: string;
  commitSHA?: string;
  perfsenseSHA?: string;
  configHash?: string;
  runs: number;
  warmup?: number;
  env?: EnvironmentFingerprint;
  pages: Record<string, BaselinePage>;
  source: string;
}

export interface ThresholdLevel {
  warning: number;
  fail: number;
  /**
   * Optional ceiling status applied after classification: 'warning' caps
   * REGRESSION at WARNING, 'pass' caps everything at PASS. Used for metrics
   * whose probes are warn-only until their variance is characterized.
   */
  maxStatus?: 'pass' | 'warning';
}

export interface PerfSenseConfig {
  thresholds: Record<string, ThresholdLevel>;
}

export type CheckStatus =
  | "PASS"
  | "WARNING"
  | "REGRESSION"
  | "IMPROVEMENT"
  | "LIKELY_NOISE"
  | "NO_BASELINE"
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
