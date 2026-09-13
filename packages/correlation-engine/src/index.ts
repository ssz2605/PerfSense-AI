import type { Evidence, EvidenceHighlight, MetricMeta } from '@perfsense/core';

// ── Types ──────────────────────────────────────────────────────────────

export type ConfidenceTier = 'direct' | 'strong' | 'moderate' | 'weak' | 'inconclusive';

export interface RegressionEntry {
  metric: string;
  baselineMedian: number;
  currentMedian: number;
  deltaPercent: number;
  pValue: number;
  effectSize: number;
  confidenceInterval: [number, number];
}

export interface CorrelationInput {
  regression: RegressionEntry[];
  evidence: Evidence[];
  metricSchemas: Record<string, MetricMeta>;
  sourceMapDir?: string;
  repoDir?: string;
}

export interface RankedEvidence extends Evidence {
  relevance: ConfidenceTier;
  relevanceLabel: string;
}

export interface SourceLocation {
  originalFile: string;
  originalLine: number;
  originalColumn: number;
  minifiedFile: string;
  minifiedLine: number;
  confidence: 'exact' | 'approximate' | 'unavailable';
}

export interface BlameInfo {
  commit: string;
  author: string;
  email: string;
  date: string;
  message: string;
  line: number;
  confidence: 'exact' | 'approximate' | 'unavailable';
}

export interface CauseEvidence {
  /** Changed file on the measured code path. */
  file: string;
  /** Line of the change in the new file, when known. */
  line?: number;
  /** Enclosing function context from the diff hunk, when git provides it. */
  function?: string;
  /** Human description of the performance-sensitive change. */
  changeType?: string;
  /** Direction the change moves the measured operation. */
  direction: 'increased' | 'decreased' | 'added' | 'removed' | 'unknown';
  /** Metric this candidate explains. */
  metric: string;
  /** Observed regression delta used for the direction check. */
  deltaPercent: number;
}

export interface LikelyCause {
  description: string;
  source: string;
  sourceLocation?: SourceLocation;
  blame?: BlameInfo;
  confidence: ConfidenceTier;
  evidenceIds: string[];
  /** Concise, evidence-based engineering rationale (what/where/why/direction). */
  rationale?: string;
  /** Structured facts behind the rationale, usable by any reporter. */
  causeEvidence?: CauseEvidence;
}

export interface MetricCorrelation {
  regression: RegressionEntry;
  evidence: RankedEvidence[];
  likelyCause: LikelyCause | null;
  filteredEvidence: number;
}

export interface CrossMetricCause {
  description: string;
  source: string;
  sourceLocation?: SourceLocation;
  blame?: BlameInfo;
  confidence: ConfidenceTier;
  affectedMetrics: string[];
  evidenceIds: string[];
}

export interface CorrelationResult {
  metrics: Record<string, MetricCorrelation>;
  crossMetricCauses: CrossMetricCause[];
  summary: {
    totalRegressions: number;
    metricsWithCause: number;
    metricsInconclusive: number;
  };
}

// ── Constants ──────────────────────────────────────────────────────────

type EvidenceType = Evidence['type'];

const METRIC_EVIDENCE_AFFINITY: Record<string, EvidenceType[]> = {
  ttfb:                ['network', 'git-diff'],
  fcp:                 ['trace', 'network', 'git-diff'],
  lcp:                 ['trace', 'network', 'git-diff'],
  playbacklatency:     ['trace', 'git-diff'],
  audiodrift:          ['trace', 'git-diff'],
  stageupdatetime:     ['trace', 'git-diff'],
  blockthroughput:     ['trace', 'git-diff'],
  projectloadtime:     ['network', 'trace', 'git-diff'],
};

/**
 * Metric-name family tokens → code-path marker substrings.
 * Engine-level data that generalizes across every PR and every metric: a metric
 * whose name contains one of the family tokens is treated as measuring the
 * corresponding code path, so a git diff that changes a file matching those
 * markers can be scored as causal for that metric. This is not a per-PR or
 * per-metric mapping; it is a family-level affinity model.
 */
const METRIC_CODE_PATH_AFFINITY: Record<string, string[]> = {
  export:   ['save', 'export', 'serialize', 'midi'],
  midi:     ['save', 'export', 'serialize', 'midi'],
  save:     ['save', 'export', 'serialize'],
  load:     ['load', 'open', 'deserialize', 'project'],
  open:     ['load', 'open', 'project', 'deserialize'],
  project:  ['load', 'open', 'project', 'deserialize'],
  playback: ['audio', 'play', 'sound', 'singer', 'turtle'],
  latency:  ['audio', 'play', 'sound', 'singer', 'latency'],
  audio:    ['audio', 'play', 'sound', 'singer', 'synth'],
  drift:    ['audio', 'play', 'sound', 'singer', 'clock', 'timer'],
  render:   ['render', 'stage', 'canvas', 'artwork', 'block'],
  stage:    ['stage', 'turtle', 'canvas', 'render', 'block'],
  block:    ['block', 'stack', 'palette', 'artwork', 'turtle'],
  throughput: ['block', 'stack', 'turtle', 'logo', 'activity'],
};

const EVIDENCE_TYPE_PRIORITY: Record<EvidenceType, number> = {
  trace:    0,
  network:  1,
  'git-diff': 2,
};

// ── Affinity helpers ────────────────────────────────────────────────────

function getRelevantTypes(metric: string): EvidenceType[] {
  const lower = metric.toLowerCase();
  if (METRIC_EVIDENCE_AFFINITY[lower]) return METRIC_EVIDENCE_AFFINITY[lower];
  return ['trace', 'network', 'git-diff'];
}

/**
 * Code-path marker substrings for a metric, derived from the family tokens
 * present in the metric name.
 */
function getCodePathMarkers(metric: string): string[] {
  const lower = metric.toLowerCase();
  const markers = new Set<string>();
  for (const [token, paths] of Object.entries(METRIC_CODE_PATH_AFFINITY)) {
    if (lower.includes(token)) {
      for (const p of paths) markers.add(p);
    }
  }
  return Array.from(markers);
}

/**
 * Changed file paths named in a git-diff evidence item (details.changes plus
 * file:line values embedded in highlights).
 */
function gitDiffChangedFiles(evidence: Evidence): string[] {
  const files: string[] = [];
  const details = (evidence.details ?? {}) as { changes?: Array<{ file?: string }> };
  if (Array.isArray(details.changes)) {
    for (const c of details.changes) {
      if (c.file) files.push(c.file);
    }
  }
  for (const hl of evidence.highlights) {
    const match = hl.value.match(/([\w\-./]+\.\w+)(?::\d+)?/);
    if (match && !files.includes(match[1])) files.push(match[1]);
  }
  return files;
}

/** True when any changed file matches a code-path marker for the metric. */
function diffTouchesMetricPath(evidence: Evidence, metric: string): boolean {
  const markers = getCodePathMarkers(metric);
  if (markers.length === 0) return false;
  const lowerMarkers = markers.map((m) => m.toLowerCase());
  return gitDiffChangedFiles(evidence).some((file) => {
    const lower = file.toLowerCase();
    return lowerMarkers.some((m) => lower.includes(m));
  });
}

/** The 'Perf-sensitive change' highlight of a git-diff evidence item, if any. */
function perfSensitiveHighlight(evidence: Evidence): EvidenceHighlight | undefined {
  return highlightByLabel(evidence, 'perf-sensitive');
}

type PerfDirection = 'increased' | 'decreased' | 'added' | 'removed' | 'unknown';

/**
 * Direction of a perf-sensitive change, parsed from the trailing
 * `(increased|decreased|added|removed)` marker of its highlight value.
 */
function perfDirection(highlight: EvidenceHighlight): PerfDirection {
  const match = highlight.value.match(/\((increased|decreased|added|removed)\)\s*$/);
  if (!match) return 'unknown';
  return match[1] as PerfDirection;
}

/**
 * Whether a perf-sensitive change direction is consistent with the observed
 * regression. A slowdown (deltaPercent > 0) is explained by added/increased
 * work or delay, and contradicted by removed/decreased work. Unknown direction
 * returns null (strong but not direct).
 */
function directionConsistent(
  direction: PerfDirection,
  deltaPercent: number,
): boolean | null {
  if (direction === 'increased' || direction === 'added') return deltaPercent >= 0;
  if (direction === 'decreased' || direction === 'removed') return deltaPercent < 0;
  return null;
}

function isRelevantFor(evidenceType: EvidenceType, metric: string): boolean {
  return getRelevantTypes(metric).includes(evidenceType);
}

// ── Evidence inspection helpers ────────────────────────────────────────

function highlightByLabel(ev: Evidence, labelPrefix: string): EvidenceHighlight | undefined {
  return ev.highlights.find((h) => h.label.toLowerCase().startsWith(labelPrefix.toLowerCase()));
}

function hasLongTask(ev: Evidence): boolean {
  const hl = highlightByLabel(ev, 'long task');
  if (!hl) return false;
  const match = hl.value.match(/(\d+(?:\.\d+)?)\s*ms/);
  return match !== null && parseFloat(match[1]) >= 15;
}

function timingOverlapsMetric(_ev: Evidence, _metric: string): boolean {
  const hl = highlightByLabel(_ev, 'blocked during');
  if (!hl) return false;
  const val = hl.value.toLowerCase();
  const lcpMetrics = ['lcp', 'fcp', 'largest contentful paint', 'first contentful paint'];
  const playbackMetrics = ['playback', 'audio', 'sound'];
  if (lcpMetrics.some((m) => _metric.toLowerCase().includes(m))) {
    return val.includes('lcp') || val.includes('paint');
  }
  if (playbackMetrics.some((m) => _metric.toLowerCase().includes(m))) {
    return val.includes('playback') || val.includes('audio');
  }
  return false;
}

function hasSlowRequest(ev: Evidence): boolean {
  const hl = highlightByLabel(ev, 'slowest request');
  if (!hl) return false;
  const match = hl.value.match(/(\d+(?:\.\d+)?)\s*ms/);
  return match !== null && parseFloat(match[1]) >= 50;
}

function hasBundleChanges(ev: Evidence): boolean {
  const hl = highlightByLabel(ev, 'bundle-affecting');
  return hl !== undefined;
}

// ── Confidence tier assignment ─────────────────────────────────────────

function assignConfidence(
  evidence: Evidence,
  metric: string,
  regression: RegressionEntry,
): { tier: ConfidenceTier; label: string } {
  if (evidence.type === 'trace') {
    if (hasLongTask(evidence) && timingOverlapsMetric(evidence, metric)) {
      return { tier: 'direct', label: 'Trace long task overlaps with metric timing window' };
    }
    if (hasLongTask(evidence)) {
      return { tier: 'strong', label: 'Trace shows long task (timing not verified)' };
    }
    if (evidence.highlights.length > 0) {
      return { tier: 'moderate', label: 'Trace data available' };
    }
    return { tier: 'weak', label: 'Trace collected but no significant findings' };
  }

  if (evidence.type === 'network') {
    if (hasSlowRequest(evidence)) {
      return { tier: 'strong', label: 'Network waterfall shows slow resource' };
    }
    if (evidence.highlights.length > 0) {
      return { tier: 'moderate', label: 'Network data available' };
    }
    return { tier: 'weak', label: 'Network collected but no significant findings' };
  }

  if (evidence.type === 'git-diff') {
    // Generic causal localization: a perf-sensitive change landing on the
    // metric's measured code path is strong evidence, gated on direction
    // consistency with the observed regression.
    const perfHl = perfSensitiveHighlight(evidence);
    const onPath = perfHl ? diffTouchesMetricPath(evidence, metric) : false;
    if (perfHl && onPath) {
      const direction = perfDirection(perfHl);
      const consistent = directionConsistent(direction, regression.deltaPercent);
      if (consistent === true) {
        return { tier: 'direct', label: 'Git diff changes the metric\'s measured code path with a perf-sensitive change' };
      }
      if (consistent === false) {
        // Fresh signal: the change moved in the opposite direction of the
        // regression, so it cannot be the cause — keep the honest weak tier.
        return { tier: 'weak', label: 'Git diff perf-sensitive change contradicts the regression direction' };
      }
      return { tier: 'strong', label: 'Git diff changes the metric\'s measured code path (perf-sensitive, direction unknown)' };
    }
    if (perfHl && !onPath) {
      return { tier: 'weak', label: 'Git diff has perf-sensitive change but outside the metric\'s measured code path' };
    }
    if (hasBundleChanges(evidence)) {
      return { tier: 'moderate', label: 'Git diff shows bundle-affecting changes' };
    }
    if (evidence.highlights.length > 0) {
      return { tier: 'weak', label: 'Git diff shows non-bundle changes' };
    }
    return { tier: 'inconclusive', label: 'No interpretable evidence' };
  }

  return { tier: 'inconclusive', label: 'No interpretable evidence' };
}

// ── Source extraction helpers ──────────────────────────────────────────

function extractSource(evidence: Evidence): string {
  // Prefer the changed file named by a perf-sensitive highlight for git-diff
  // evidence so the reported source points at the actual causal location.
  if (evidence.type === 'git-diff') {
    const perfHl = perfSensitiveHighlight(evidence);
    if (perfHl) {
      const match = perfHl.value.match(/([\w\-./]+\.\w+)(?::\d+)?/);
      if (match) return match[0] || match[1];
    }
  }
  for (const hl of evidence.highlights) {
    const match = hl.value.match(/([\w\-./]+\.\w+)(?::\d+)?/);
    if (match) return match[0] || match[1];
  }
  return `${evidence.type} evidence (${evidence.id})`;
}

function sourcesMatch(sourceA: string, sourceB: string): boolean {
  const a = sourceA.replace(/:\d+$/, '');
  const b = sourceB.replace(/:\d+$/, '');
  return a === b;
}

// ── Main correlate function ────────────────────────────────────────────

function resolveSourceIfPossible(source: string, sourceMapDir?: string, repoDir?: string): { sourceLocation?: SourceLocation; blame?: BlameInfo } {
  let sourceLocation: SourceLocation | undefined;
  let blame: BlameInfo | undefined;

  if (sourceMapDir) {
    try {
      const { resolveTraceLocation } = require('@perfsense/source-mapper');
      sourceLocation = resolveTraceLocation(source, sourceMapDir) || undefined;
    } catch { /* source-mapper not available */ }
  }

  if (repoDir && sourceLocation) {
    try {
      const { gitBlame } = require('@perfsense/git-blame');
      const blameResult = gitBlame(sourceLocation.originalFile, sourceLocation.originalLine, repoDir);
      if (blameResult) {
        blame = blameResult;
      }
    } catch { /* git-blame not available */ }
  } else if (repoDir) {
    const fileMatch = source.match(/([\w\-./]+\.\w+):(\d+)/);
    if (fileMatch) {
      try {
        const { gitBlame } = require('@perfsense/git-blame');
        const blameResult = gitBlame(fileMatch[1], parseInt(fileMatch[2], 10), repoDir);
        if (blameResult) {
          blame = blameResult;
        }
      } catch { /* git-blame not available */ }
    }
  }

  return { sourceLocation, blame };
}

/** Perf-sensitive change entries carried on git-diff evidence details. */
function gitDiffPerfSensitiveEntries(evidence: Evidence): Array<{
  file: string;
  line?: number;
  function?: string;
  description?: string;
  direction: CauseEvidence['direction'];
}> {
  const details = (evidence.details ?? {}) as {
    perfSensitive?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(details.perfSensitive)) return [];
  const validDirections = ['increased', 'decreased', 'added', 'removed', 'unknown'];
  return details.perfSensitive
    .filter((p) => typeof p.file === 'string')
    .map((p) => ({
      file: p.file as string,
      line: typeof p.line === 'number' ? (p.line as number) : undefined,
      function: typeof p.function === 'string' ? (p.function as string) : undefined,
      description: typeof p.description === 'string' ? (p.description as string) : undefined,
      direction: validDirections.includes(p.direction as string)
        ? (p.direction as CauseEvidence['direction'])
        : 'unknown',
    }));
}

/**
 * Structured facts behind a likely cause, extracted from the top-ranked
 * evidence. Used by reporters to explain the reasoning without reconstructing
 * it from raw strings.
 */
function buildCauseEvidence(
  top: RankedEvidence,
  regression: RegressionEntry,
): CauseEvidence | undefined {
  if (top.type === 'git-diff') {
    const entries = gitDiffPerfSensitiveEntries(top);
    if (entries.length > 0) {
      const first = entries[0];
      return {
        file: first.file,
        line: first.line,
        function: first.function,
        changeType: first.description,
        direction: first.direction,
        metric: regression.metric,
        deltaPercent: regression.deltaPercent,
      };
    }
    const sourceMatch = extractSource(top).match(/^(.+):(\d+)$/);
    if (sourceMatch) {
      return {
        file: sourceMatch[1],
        line: parseInt(sourceMatch[2], 10),
        direction: 'unknown',
        metric: regression.metric,
        deltaPercent: regression.deltaPercent,
      };
    }
  }
  return undefined;
}

/**
 * Concise, evidence-based engineering rationale for a likely cause. Answers:
 * what changed, where, why it is relevant to the metric, and why the direction
 * is consistent with the observed regression. Generated from structured
 * evidence — never from hidden chain-of-thought.
 */
function buildRationale(
  top: RankedEvidence,
  regression: RegressionEntry,
  causeEvidence?: CauseEvidence,
): string {
  const metric = regression.metric;
  const delta = regression.deltaPercent;
  const sign = delta >= 0 ? '+' : '';
  const trend = delta >= 0 ? 'slower' : 'faster';

  if (top.type === 'git-diff') {
    if (!causeEvidence) {
      return `${top.summary} This diff evidence was matched against ${metric} (${sign}${delta.toFixed(1)}% change).`;
    }
    const where = causeEvidence.line !== undefined
      ? `${causeEvidence.file}:${causeEvidence.line}`
      : causeEvidence.file;
    const parts: string[] = [];
    parts.push(
      `The diff changes ${where}, which is on the code path measured by ${metric}.`,
    );
    if (causeEvidence.changeType) {
      parts.push(`The change is performance-sensitive: ${causeEvidence.changeType}.`);
    }
    if (causeEvidence.function) {
      parts.push(`It is inside ${causeEvidence.function}.`);
    }
    const addsWork =
      causeEvidence.direction === 'increased' || causeEvidence.direction === 'added';
    const removesWork =
      causeEvidence.direction === 'decreased' || causeEvidence.direction === 'removed';
    if (addsWork) {
      if (delta >= 0) {
        parts.push(
          `The change adds work or delay, which is consistent with the observed ${sign}${delta.toFixed(1)}% ${trend} result for ${metric}.`,
        );
      } else {
        parts.push(
          `The change adds work or delay, which is not consistent with the observed ${sign}${delta.toFixed(1)}% result for ${metric}.`,
        );
      }
    } else if (removesWork) {
      if (delta < 0) {
        parts.push(
          `The change removes work, which is consistent with the observed ${sign}${delta.toFixed(1)}% ${trend} result for ${metric}.`,
        );
      } else {
        parts.push(
          `The change removes work, which is not consistent with the observed ${sign}${delta.toFixed(1)}% result for ${metric}.`,
        );
      }
    } else {
      parts.push(`The direction of the change relative to ${metric} is not explicit in the diff.`);
    }
    parts.push(
      `This change is the likely cause because the diff lands on the measured code path and carries a performance-sensitive signal.`,
    );
    return parts.join(' ');
  }

  if (top.type === 'trace') {
    return `A long task in the Chrome trace overlaps the timing window measured by ${metric} (${sign}${delta.toFixed(1)}% ${trend}). Main-thread blocking of this duration matches the observed change.`;
  }

  if (top.type === 'network') {
    return `The network waterfall shows a slow resource relevant to ${metric} (${sign}${delta.toFixed(1)}% ${trend}). This is consistent with the observed change.`;
  }

  return `${top.summary} This evidence was selected for ${metric} (${sign}${delta.toFixed(1)}% change).`;
}

export function correlate(input: CorrelationInput): CorrelationResult {
  const { regression, evidence, metricSchemas: _metricSchemas, sourceMapDir, repoDir } = input;

  const crossMetricCauses: CrossMetricCause[] = [];
  const metrics: Record<string, MetricCorrelation> = {};

  for (const reg of regression) {
    // Step 2: Filter evidence by affinity
    const allEvidence = evidence.filter((ev) => isRelevantFor(ev.type, reg.metric));
    const filteredCount = evidence.length - allEvidence.length;

    // Step 3: Rank evidence — priority by type, then by confidence descending
    const ranked: RankedEvidence[] = allEvidence
      .map((ev) => {
        const { tier, label } = assignConfidence(ev, reg.metric, reg);
        const rankedEv: RankedEvidence = {
          ...ev,
          relevance: tier,
          relevanceLabel: label,
        };
        return rankedEv;
      })
      .sort((a, b) => {
        const typeDiff = EVIDENCE_TYPE_PRIORITY[a.type] - EVIDENCE_TYPE_PRIORITY[b.type];
        if (typeDiff !== 0) return typeDiff;
        const tierOrder: Record<ConfidenceTier, number> = {
          direct: 0, strong: 1, moderate: 2, weak: 3, inconclusive: 4,
        };
        return (tierOrder[a.relevance] ?? 9) - (tierOrder[b.relevance] ?? 9);
      });

    // Step 5: Extract likely cause
    let likelyCause: LikelyCause | null = null;
    const top = ranked[0];
    if (top && top.relevance !== 'inconclusive' && top.relevance !== 'weak') {
      const source = extractSource(top);
      const { sourceLocation, blame } = resolveSourceIfPossible(source, sourceMapDir, repoDir);
      const causeEvidence = buildCauseEvidence(top, reg);
      likelyCause = {
        description: top.summary,
        source,
        sourceLocation,
        blame,
        confidence: top.relevance,
        evidenceIds: [top.id],
        rationale: buildRationale(top, reg, causeEvidence),
        causeEvidence,
      };
    }

    metrics[reg.metric] = {
      regression: reg,
      evidence: ranked,
      likelyCause,
      filteredEvidence: filteredCount,
    };
  }

  // Step 6: Cross-metric deduplication
  const metricNames = Object.keys(metrics);
  for (let i = 0; i < metricNames.length; i++) {
    const mcA = metrics[metricNames[i]];
    const causeA = mcA.likelyCause;
    if (!causeA) continue;
    for (let j = i + 1; j < metricNames.length; j++) {
      const mcB = metrics[metricNames[j]];
      const causeB = mcB.likelyCause;
      if (!causeB) continue;
      if (sourcesMatch(causeA.source, causeB.source)) {
        const existing = crossMetricCauses.find(
          (c) => c.evidenceIds.includes(causeA.evidenceIds[0]) ||
                 c.evidenceIds.includes(causeB.evidenceIds[0]),
        );
        if (existing) {
          if (!existing.affectedMetrics.includes(metricNames[i])) existing.affectedMetrics.push(metricNames[i]);
          if (!existing.affectedMetrics.includes(metricNames[j])) existing.affectedMetrics.push(metricNames[j]);
          if (!existing.evidenceIds.includes(causeA.evidenceIds[0])) existing.evidenceIds.push(causeA.evidenceIds[0]);
          if (!existing.evidenceIds.includes(causeB.evidenceIds[0])) existing.evidenceIds.push(causeB.evidenceIds[0]);
        } else {
          crossMetricCauses.push({
            description: causeA.description,
            source: causeA.source,
            sourceLocation: causeA.sourceLocation,
            blame: causeA.blame,
            confidence: causeA.confidence,
            affectedMetrics: [metricNames[i], metricNames[j]],
            evidenceIds: [causeA.evidenceIds[0], causeB.evidenceIds[0]],
          });
        }
        mcA.likelyCause = null;
        mcB.likelyCause = null;
      }
    }
  }

  // Summary
  const totalRegressions = regression.length;
  let metricsWithCause = 0;
  let metricsInconclusive = 0;
  for (const m of Object.values(metrics)) {
    if (m.likelyCause) metricsWithCause++;
    else if (m.evidence.length === 0) metricsInconclusive++;
  }

  return {
    metrics,
    crossMetricCauses,
    summary: { totalRegressions, metricsWithCause, metricsInconclusive },
  };
}
