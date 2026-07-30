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

export interface LikelyCause {
  description: string;
  source: string;
  sourceLocation?: SourceLocation;
  blame?: BlameInfo;
  confidence: ConfidenceTier;
  evidenceIds: string[];
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

function assignConfidence(evidence: Evidence, metric: string): { tier: ConfidenceTier; label: string } {
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
  for (const hl of evidence.highlights) {
    const match = hl.value.match(/([\w\-./]+\.\w+)(?::\d+)?/);
    if (match) return match[1];
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
        const { tier, label } = assignConfidence(ev, reg.metric);
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
      likelyCause = {
        description: top.summary,
        source,
        sourceLocation,
        blame,
        confidence: top.relevance,
        evidenceIds: [top.id],
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
