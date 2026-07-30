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
