export interface MetricMeta {
  unit: string;
  lowerIsBetter: boolean;
  type: 'duration' | 'score' | 'count';
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
  /**
   * Ordered interaction phases per page name. Each phase runs in sequence inside
   * one page so composites like "openProject then playToCompletion" work on a
   * single measured run. Takes precedence over `scenario` for pages that list one.
   */
  scenarios?: Record<string, string[]>;
  /** Fixture file name per page name, used by the openProject scenario. */
  fixtures?: Record<string, string>;
}

export interface BaselineMetricStats {
  median: number;
  p10: number;
  p90: number;
  values: number[];
}

export interface BaselinePage {
  [metricName: string]: BaselineMetricStats;
}

export interface BaselineData {
  schema: string;
  createdAt: string;
  runs: number;
  pages: Record<string, BaselinePage>;
  source: string;
}

export interface ThresholdLevel {
  warning: number;
  fail: number;
}

export interface PerfSenseConfig {
  thresholds: Record<string, ThresholdLevel>;
}

export type CheckStatus = 'PASS' | 'WARNING' | 'REGRESSION';

export interface MetricCheckResult {
  page: string;
  metric: string;
  status: CheckStatus;
  deltaPercent: number;
  failThreshold: number;
  baselineMedian: number;
  currentMedian: number;
}

export interface EvidenceHighlight {
  label: string;
  value: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface Evidence {
  id: string;
  type: 'trace' | 'network' | 'git-diff';
  metricName: string;
  timestamp: number;
  confidence: number;
  summary: string;
  highlights: EvidenceHighlight[];
  details?: unknown;
}
