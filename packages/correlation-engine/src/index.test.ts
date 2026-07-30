import { describe, it, expect } from 'vitest';
import type { Evidence, MetricMeta } from '@perfsense/core';
import { correlate } from './index';
import type { CorrelationInput, ConfidenceTier } from './index';

// ── Helpers ────────────────────────────────────────────────────────────

function makeEvidence(overrides: Partial<Evidence> & { id?: string; type?: Evidence['type'] }): Evidence {
  return {
    id: 'ev-1',
    type: 'trace',
    metricName: '',
    timestamp: 0,
    confidence: 1,
    summary: 'Test evidence',
    highlights: [],
    ...overrides,
  } as Evidence;
}

function makeRegression(overrides?: Partial<CorrelationInput['regression'][0]>): CorrelationInput['regression'][0] {
  return {
    metric: 'playbackLatency',
    baselineMedian: 2.8,
    currentMedian: 38.9,
    deltaPercent: 1289,
    pValue: 0.0001,
    effectSize: 1.0,
    confidenceInterval: [35, 42],
    ...overrides,
  };
}

const defaultSchemas: Record<string, MetricMeta> = {
  playbackLatency: { unit: 'ms', lowerIsBetter: true, type: 'duration' },
  audioDrift: { unit: 'ms', lowerIsBetter: true, type: 'duration' },
  ttfb: { unit: 'ms', lowerIsBetter: true, type: 'duration' },
  fcp: { unit: 'ms', lowerIsBetter: true, type: 'duration' },
  lcp: { unit: 'ms', lowerIsBetter: true, type: 'duration' },
  projectLoadTime: { unit: 'ms', lowerIsBetter: true, type: 'duration' },
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('grouping', () => {
  it('single metric with matching evidence', () => {
    const ev = makeEvidence({ id: 'trace-1', type: 'trace', metricName: 'playbackLatency' });
    const result = correlate({ regression: [makeRegression()], evidence: [ev], metricSchemas: defaultSchemas });
    expect(result.metrics.playbackLatency).toBeDefined();
    expect(result.metrics.playbackLatency.evidence.length).toBe(1);
    expect(result.metrics.playbackLatency.filteredEvidence).toBe(0);
  });

  it('multiple metrics each get their own correlation', () => {
    const ev1 = makeEvidence({ id: 'trace-1', type: 'trace' });
    const ev2 = makeEvidence({ id: 'net-1', type: 'network' });
    const result = correlate({
      regression: [
        makeRegression({ metric: 'playbackLatency' }),
        makeRegression({ metric: 'ttfb', baselineMedian: 3, currentMedian: 6, deltaPercent: 100, pValue: 0.01, effectSize: 0.8, confidenceInterval: [4, 8] }),
      ],
      evidence: [ev1, ev2],
      metricSchemas: defaultSchemas,
    });
    // playbackLatency (affinity: trace, git-diff) gets ev1 (trace); filters ev2 (network)
    // ttfb (affinity: network, git-diff) gets ev2 (network); filters ev1 (trace)
    expect(result.metrics.playbackLatency).toBeDefined();
    expect(result.metrics.ttfb).toBeDefined();
    expect(result.metrics.playbackLatency.evidence.length).toBe(1);
    expect(result.metrics.playbackLatency.evidence[0].type).toBe('trace');
    expect(result.metrics.ttfb.evidence.length).toBe(1);
    expect(result.metrics.ttfb.evidence[0].type).toBe('network');
  });

  it('overlapping evidence is shared across relevant metrics', () => {
    const ev = makeEvidence({ id: 'trace-1', type: 'trace' });
    const result = correlate({
      regression: [
        makeRegression({ metric: 'playbackLatency' }),
        makeRegression({ metric: 'audioDrift', baselineMedian: 0.5, currentMedian: 0.8, deltaPercent: 60, pValue: 0.001, effectSize: 0.9, confidenceInterval: [0.6, 1.0] }),
      ],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.evidence.length).toBe(1);
    expect(result.metrics.audioDrift.evidence.length).toBe(1);
  });

  it('network evidence is filtered out for audioDrift (no network affinity)', () => {
    const ev = makeEvidence({ id: 'net-1', type: 'network' });
    const result = correlate({
      regression: [makeRegression({ metric: 'audioDrift' })],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.audioDrift.evidence.length).toBe(0);
    expect(result.metrics.audioDrift.filteredEvidence).toBe(1);
  });

  it('unknown metric accepts all evidence types', () => {
    const ev = makeEvidence({ id: 'net-1', type: 'network' });
    const result = correlate({
      regression: [makeRegression({ metric: 'unknownMetric' })],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.unknownMetric.evidence.length).toBe(1);
  });
});

describe('ranking', () => {
  it('trace ranks higher than network within same metric', () => {
    const traceEv = makeEvidence({ id: 'trace-1', type: 'trace' });
    const netEv = makeEvidence({ id: 'net-1', type: 'network' });
    const result = correlate({
      regression: [makeRegression({ metric: 'lcp' })],
      evidence: [netEv, traceEv],
      metricSchemas: defaultSchemas,
    });
    const ev = result.metrics.lcp.evidence;
    expect(ev[0].type).toBe('trace');
    expect(ev[1].type).toBe('network');
  });

  it('higher confidence ranks higher within same type', () => {
    const strongEv = makeEvidence({
      id: 'strong-1', type: 'network',
      highlights: [{ label: 'Slowest request', value: 'data.js (120ms)', severity: 'warning' }],
    });
    const weakEv = makeEvidence({
      id: 'weak-1', type: 'network',
      highlights: [{ label: 'Total network', value: '1 request, 0.1KB', severity: 'info' }],
    });
    const result = correlate({
      regression: [makeRegression({ metric: 'ttfb' })],
      evidence: [weakEv, strongEv],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.ttfb.evidence[0].id).toBe('strong-1');
  });

  it('empty evidence group produces empty array', () => {
    const result = correlate({
      regression: [makeRegression()],
      evidence: [],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.evidence).toEqual([]);
  });
});

describe('confidence tiers', () => {
  it('direct — trace with long task overlapping metric timing window', () => {
    const ev = makeEvidence({
      id: 'trace-1', type: 'trace',
      highlights: [
        { label: 'Long task duration', value: '42ms at audio-engine.js:87', severity: 'critical' },
        { label: 'Blocked during', value: 'playback window', severity: 'warning' },
      ],
    });
    const result = correlate({
      regression: [makeRegression({ metric: 'playbackLatency' })],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.evidence[0].relevance).toBe('direct');
  });

  it('strong — trace with long task but no timing overlap', () => {
    const ev = makeEvidence({
      id: 'trace-1', type: 'trace',
      highlights: [
        { label: 'Long task duration', value: '42ms at audio-engine.js:87', severity: 'critical' },
      ],
    });
    const result = correlate({
      regression: [makeRegression({ metric: 'playbackLatency' })],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.evidence[0].relevance).toBe('strong');
  });

  it('strong — network with slow request', () => {
    const ev = makeEvidence({
      id: 'net-1', type: 'network',
      highlights: [
        { label: 'Slowest request', value: 'bundle.js (120ms)', severity: 'warning' },
      ],
    });
    const result = correlate({
      regression: [makeRegression({ metric: 'ttfb' })],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.ttfb.evidence[0].relevance).toBe('strong');
  });

  it('moderate — trace with highlights but no long task', () => {
    const ev = makeEvidence({
      id: 'trace-1', type: 'trace',
      highlights: [
        { label: 'Total page time', value: '500ms', severity: 'warning' },
      ],
    });
    const result = correlate({
      regression: [makeRegression({ metric: 'playbackLatency' })],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.evidence[0].relevance).toBe('moderate');
  });

  it('moderate — git-diff with bundle changes', () => {
    const ev = makeEvidence({
      id: 'git-1', type: 'git-diff',
      highlights: [
        { label: 'Bundle-affecting changes', value: 'audio-engine.js', severity: 'warning' },
      ],
    });
    const result = correlate({
      regression: [makeRegression()],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.evidence[0].relevance).toBe('moderate');
  });

  it('weak — git-diff without bundle changes', () => {
    const ev = makeEvidence({
      id: 'git-1', type: 'git-diff',
      highlights: [
        { label: 'Files changed', value: '2 files (+3/-1 lines)', severity: 'info' },
      ],
    });
    const result = correlate({
      regression: [makeRegression()],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.evidence[0].relevance).toBe('weak');
  });

  it('weak — trace without any highlights', () => {
    const ev = makeEvidence({
      id: 'trace-1', type: 'trace',
      highlights: [],
    });
    const result = correlate({
      regression: [makeRegression()],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.evidence[0].relevance).toBe('weak');
  });

  it('inconclusive — git-diff without any highlights', () => {
    const ev = makeEvidence({
      id: 'git-1', type: 'git-diff',
      highlights: [],
    });
    const result = correlate({
      regression: [makeRegression()],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.evidence[0].relevance).toBe('inconclusive');
  });

  it('edge inputs do not crash (null-like highlights)', () => {
    const ev = makeEvidence({
      id: 'trace-1', type: 'trace',
      highlights: [{ label: '', value: '', severity: 'info' as const }],
    });
    const result = correlate({
      regression: [makeRegression()],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.evidence.length).toBe(1);
  });
});

describe('likely cause extraction', () => {
  it('top-ranked relevant evidence becomes likely cause', () => {
    const ev = makeEvidence({
      id: 'trace-1', type: 'trace',
      highlights: [
        { label: 'Long task duration', value: '42ms', severity: 'critical' },
      ],
      summary: 'Main thread blocked 42ms by AudioContext.createBuffer',
    });
    const result = correlate({
      regression: [makeRegression()],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.likelyCause).not.toBeNull();
    expect(result.metrics.playbackLatency.likelyCause!.description).toContain('AudioContext.createBuffer');
    expect(result.metrics.playbackLatency.likelyCause!.evidenceIds).toContain('trace-1');
  });

  it('likely cause is null when only weak evidence exists', () => {
    const ev = makeEvidence({
      id: 'git-1', type: 'git-diff',
      highlights: [{ label: 'Files changed', value: '1 file (+1/-0 lines)', severity: 'info' }],
    });
    const result = correlate({
      regression: [makeRegression()],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.likelyCause).toBeNull();
  });

  it('likely cause is null when no evidence at all', () => {
    const result = correlate({
      regression: [makeRegression()],
      evidence: [],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.likelyCause).toBeNull();
  });
});

describe('cross-metric deduplication', () => {
  it('two metrics with same source are merged into one crossMetricCause', () => {
    const ev = makeEvidence({
      id: 'trace-1', type: 'trace',
      highlights: [
        { label: 'Long task duration', value: '42ms at bundle.js:142', severity: 'critical' },
      ],
      summary: 'Long task at bundle.js:142',
    });
    const result = correlate({
      regression: [
        makeRegression({ metric: 'playbackLatency' }),
        makeRegression({ metric: 'audioDrift', baselineMedian: 0.5, currentMedian: 1.0, deltaPercent: 100, pValue: 0.001, effectSize: 0.9, confidenceInterval: [0.7, 1.3] }),
      ],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.crossMetricCauses.length).toBeGreaterThanOrEqual(1);
    // Both metrics should have null likelyCause (merged out)
    expect(result.metrics.playbackLatency.likelyCause).toBeNull();
    expect(result.metrics.audioDrift.likelyCause).toBeNull();
    const cross = result.crossMetricCauses[0];
    expect(cross.affectedMetrics).toContain('playbackLatency');
    expect(cross.affectedMetrics).toContain('audioDrift');
  });

  it('different sources remain separate', () => {
    // Use different evidence types so each metric receives different evidence
    const ev1 = makeEvidence({
      id: 'trace-1', type: 'trace',
      highlights: [{ label: 'Long task duration', value: '30ms at audio.js:10', severity: 'critical' }],
      summary: 'Long task at audio.js:10',
    });
    const ev2 = makeEvidence({
      id: 'net-1', type: 'network',
      highlights: [{ label: 'Slowest request', value: 'layout.js (120ms)', severity: 'warning' }],
      summary: 'Slow request to layout.js:99',
    });
    const result = correlate({
      regression: [
        // playbackLatency affinity: ['trace', 'git-diff'] → gets only trace-1
        makeRegression({ metric: 'playbackLatency' }),
        // ttfb affinity: ['network', 'git-diff'] → gets only net-1
        makeRegression({ metric: 'ttfb', baselineMedian: 200, currentMedian: 350, deltaPercent: 75, pValue: 0.01, effectSize: 0.8, confidenceInterval: [300, 400] }),
      ],
      evidence: [ev1, ev2],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.likelyCause).not.toBeNull();
    expect(result.metrics.ttfb.likelyCause).not.toBeNull();
    // Different sources → not merged
    expect(result.crossMetricCauses.length).toBe(0);
  });
});

describe('edge cases', () => {
  it('empty regression produces empty result', () => {
    const result = correlate({ regression: [], evidence: [], metricSchemas: {} });
    expect(Object.keys(result.metrics).length).toBe(0);
    expect(result.summary.totalRegressions).toBe(0);
  });

  it('unknown metric name does not crash', () => {
    const ev = makeEvidence({ id: 'trace-1', type: 'trace' });
    const result = correlate({
      regression: [makeRegression({ metric: 'totallyFakeMetric' })],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.totallyFakeMetric).toBeDefined();
  });

  it('evidence with empty highlights array still works', () => {
    const ev = makeEvidence({ id: 'trace-1', type: 'trace', highlights: [] });
    const result = correlate({
      regression: [makeRegression()],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.evidence.length).toBe(1);
  });

  it('evidence with null-like metricName defaults to all-metric relevance', () => {
    const ev = makeEvidence({ id: 'trace-1', type: 'trace', metricName: '' });
    const result = correlate({
      regression: [makeRegression()],
      evidence: [ev],
      metricSchemas: defaultSchemas,
    });
    expect(result.metrics.playbackLatency.evidence.length).toBe(1);
  });
});

describe('integration — Music Blocks realistic data', () => {
  it('full pipeline with MB-shaped data', () => {
    const input: CorrelationInput = {
      regression: [{
        metric: 'playbackLatency',
        baselineMedian: 2.8,
        currentMedian: 38.9,
        deltaPercent: 1289,
        pValue: 0.0001,
        effectSize: 1.0,
        confidenceInterval: [35, 42],
      }],
      evidence: [
        {
          id: 'trace-1', type: 'trace', metricName: 'playbackLatency',
          timestamp: 0, confidence: 1.0,
          summary: 'Main thread blocked 42ms by AudioContext.createBuffer at audio-engine.js:87',
          highlights: [
            { label: 'Long task duration', value: '42ms', severity: 'critical' },
            { label: 'Source location', value: 'audio-engine.js:87', severity: 'warning' },
            { label: 'Blocked during', value: 'playback window', severity: 'warning' },
          ],
        },
        {
          id: 'git-1', type: 'git-diff', metricName: 'playbackLatency',
          timestamp: 0, confidence: 1.0,
          summary: '3 files changed, audio-engine.js modified (+87 -12 lines)',
          highlights: [
            { label: 'Files changed', value: '3', severity: 'info' },
            { label: 'Bundle-affecting files', value: 'audio-engine.js', severity: 'warning' },
          ],
        },
        {
          id: 'net-1', type: 'network', metricName: '',
          timestamp: 0, confidence: 1.0,
          summary: '2 requests, 0 failures, 1.2KB total',
          highlights: [
            { label: 'Requests', value: '2', severity: 'info' },
            { label: 'Slowest request', value: 'audio-engine.js (42ms)', severity: 'warning' },
          ],
        },
      ],
      metricSchemas: { playbackLatency: { unit: 'ms', lowerIsBetter: true, type: 'duration' } },
    };

    const result = correlate(input);

    expect(result.metrics.playbackLatency).toBeDefined();

    // likelyCause is set — trace-1 is direct (long task + timing overlap)
    expect(result.metrics.playbackLatency.likelyCause).not.toBeNull();
    expect(result.metrics.playbackLatency.likelyCause!.confidence).toBe('direct');
    expect(result.metrics.playbackLatency.likelyCause!.description).toContain('audio-engine.js:87');

    // Evidence ranked: trace-1 (direct) > git-1 (moderate)
    // net-1 is filtered out because playbackLatency affinity excludes network
    const evidenceList = result.metrics.playbackLatency.evidence;
    expect(evidenceList.length).toBe(2);
    expect(evidenceList[0].id).toBe('trace-1');
    expect(evidenceList[0].relevance).toBe('direct');
    expect(evidenceList[1].id).toBe('git-1');
    expect(evidenceList[1].relevance).toBe('moderate');

    // filteredEvidence = 1 (net-1 was filtered out)
    expect(result.metrics.playbackLatency.filteredEvidence).toBe(1);
  });
});
