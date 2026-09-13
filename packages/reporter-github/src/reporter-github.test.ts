import { describe, it, expect } from 'vitest';
import { generatePRComment, type CheckResult } from './index';
import type { LikelyCause } from '@perfsense/correlation-engine';

const PR_27 = { pr: '27', head: 'c46d920', baselineRef: 'origin/master', matrix: 'Music Blocks Benchmark Matrix' };

function makeEntry(partial?: Partial<CheckResult['results'][number]>) {
  return {
    page: 'RainbowConnection.html',
    metric: 'exportMIDITime',
    status: 'PASS' as const,
    deltaPercent: 0,
    baselineMedian: 1000,
    currentMedian: 1000,
    failThreshold: 10,
    ...partial,
  };
}

function makeCause(partial?: Partial<LikelyCause>): LikelyCause {
  return {
    description: 'Git diff: 1 file changed, 1 perf-sensitive change(s)',
    source: 'js/SaveInterface.js:42',
    confidence: 'direct',
    evidenceIds: ['git-export'],
    rationale:
      'The diff changes js/SaveInterface.js:42, which is on the code path measured by exportMIDITime. ' +
      'The change is performance-sensitive: Scheduling delay increased (500ms → 2500ms). ' +
      'The change adds work or delay, which is consistent with the observed +159.4% slower result for exportMIDITime.',
    causeEvidence: {
      file: 'js/SaveInterface.js',
      line: 42,
      function: 'afterSaveMIDI()',
      changeType: 'Scheduling delay increased (500ms → 2500ms)',
      direction: 'increased',
      metric: 'exportMIDITime',
      deltaPercent: 159.4,
    },
    ...partial,
  };
}

describe('matrix filtering', () => {
  it('shows only Benchmark Matrix fixture/metric combinations', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'Frere-Jacques.html', metric: 'callbackLatencyMean', status: 'PASS', deltaPercent: 1.2, baselineMedian: 40, currentMedian: 40.5 }),
        // Not part of the approved Frère Jacques matrix — must not appear.
        makeEntry({ page: 'Frere-Jacques.html', metric: 'projectLoadTime', status: 'REGRESSION', deltaPercent: 33.7, baselineMedian: 8959, currentMedian: 11977 }),
        makeEntry({ page: 'Frere-Jacques.html', metric: 'executionTime', status: 'REGRESSION', deltaPercent: 9.9, baselineMedian: 100, currentMedian: 110 }),
        makeEntry({ page: 'Frere-Jacques.html', metric: 'maxActionDepth', status: 'REGRESSION', deltaPercent: 5, baselineMedian: 10, currentMedian: 10.5 }),
        makeEntry({ page: 'crabcanon-plot.html', metric: 'scheduleLagMean', status: 'PASS', deltaPercent: -2, baselineMedian: 12, currentMedian: 11.8 }),
        // Extra raw metric that is not part of the crabcanon matrix.
        makeEntry({ page: 'crabcanon-plot.html', metric: 'retainedHeap', status: 'REGRESSION', deltaPercent: 50, baselineMedian: 1000, currentMedian: 1500 }),
      ],
      summary: { pass: 2, warning: 0, regression: 4, failed: true },
    };
    const comment = generatePRComment(result, PR_27);

    expect(comment).toContain('callbackLatencyMean');
    expect(comment).toContain('scheduleLagMean');
    expect(comment).not.toContain('projectLoadTime');
    expect(comment).not.toContain('executionTime');
    expect(comment).not.toContain('maxActionDepth');
    expect(comment).not.toContain('retainedHeap');
  });

  it('keeps metrics associated with their fixture (no global grouping)', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'RainbowConnection.html', metric: 'projectLoadTime', status: 'PASS', deltaPercent: 0, baselineMedian: 8959, currentMedian: 8959 }),
        makeEntry({ page: 'index.html', metric: 'bootstrapTotal', status: 'PASS', deltaPercent: 0, baselineMedian: 5370, currentMedian: 5370 }),
      ],
      summary: { pass: 2, warning: 0, regression: 0, failed: false },
    };
    const comment = generatePRComment(result, PR_27);
    // Rainbow Connection section contains projectLoadTime.
    const rainbowIdx = comment.indexOf('### Rainbow Connection');
    const projectIdx = comment.indexOf('projectLoadTime');
    const emptyIdx = comment.indexOf('### index.html (bootstrap)');
    expect(rainbowIdx).toBeGreaterThan(-1);
    expect(emptyIdx).toBeGreaterThan(rainbowIdx);
    expect(projectIdx).toBeGreaterThan(rainbowIdx);
  });
});

describe('professional grouping and statuses', () => {
  it('renders each fixture once as a section with grouped metrics', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'RainbowConnection.html', metric: 'exportMIDITime', status: 'PASS', deltaPercent: 0 }),
        makeEntry({ page: 'RainbowConnection.html', metric: 'saveTime', status: 'PASS', deltaPercent: -1 }),
        makeEntry({ page: 'RainbowConnection.html', metric: 'memoryDelta', status: 'PASS', deltaPercent: 0 }),
        makeEntry({ page: 'index.html', metric: 'bootstrapTotal', status: 'PASS', deltaPercent: 0 }),
      ],
      summary: { pass: 4, warning: 0, regression: 0, failed: false },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment.match(/### Rainbow Connection/g)).toHaveLength(1);
    expect(comment.match(/### index\.html \(bootstrap\)/g)).toHaveLength(1);
    const rainbow = comment.split('### index.html (bootstrap)')[0];
    expect(rainbow).toContain('exportMIDITime');
    expect(rainbow).toContain('saveTime');
    expect(rainbow).toContain('memoryDelta');
  });

  it('uses professional text statuses, not emojis or icons', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'RainbowConnection.html', metric: 'exportMIDITime', status: 'PASS', deltaPercent: 0 }),
        makeEntry({ page: 'RainbowConnection.html', metric: 'saveTime', status: 'WARNING', deltaPercent: 12 }),
        makeEntry({ page: 'RainbowConnection.html', metric: 'projectLoadTime', status: 'REGRESSION', deltaPercent: 33.7 }),
        makeEntry({ page: 'RainbowConnection.html', metric: 'memoryDelta', status: 'PASS', deltaPercent: -4 }),
      ],
      summary: { pass: 2, warning: 1, regression: 1, failed: true },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('| Passed |');
    expect(comment).toContain('| Warning |');
    expect(comment).toContain('| Regression |');
    expect(comment).toContain('| Improved |');
    expect(comment).not.toContain(':x:');
    expect(comment).not.toContain(':warning:');
    expect(comment).not.toContain(':white_check_mark:');
    expect(comment).not.toContain('✅');
    expect(comment).not.toContain('❌');
    expect(comment).not.toContain('⚠');
    expect(comment).not.toContain('🚀');
  });

  it('marks maxDepth as Unverified and excludes it from regressions', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'musical-tree.html', metric: 'maxDepth', status: 'REGRESSION', deltaPercent: 200, baselineMedian: 1, currentMedian: 3 }),
        makeEntry({ page: 'musical-tree.html', metric: 'executionTime', status: 'PASS', deltaPercent: 0 }),
      ],
      summary: { pass: 1, warning: 0, regression: 1, failed: true },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('| maxDepth | 1 | 3 | +200.0% | Unverified |');
    // Not treated as a genuine regression: absent from the regressions section.
    expect(comment).not.toContain('### maxDepth');
  });
});

describe('report structure', () => {
  it('contains header context and required sections in order', () => {
    const result: CheckResult = {
      results: [makeEntry({})],
      summary: { pass: 1, warning: 0, regression: 0, failed: false },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment.startsWith('# PerfSense Performance Report')).toBe(true);
    expect(comment).toContain('PR: 27');
    expect(comment).toContain('Head: c46d920');
    expect(comment).toContain('Baseline: origin/master');
    expect(comment).toContain('Matrix: Music Blocks Benchmark Matrix');
    const summaryIdx = comment.indexOf('## Performance Summary');
    const regressionsIdx = comment.indexOf('## Performance Regressions');
    const artifactsIdx = comment.indexOf('## Artifacts');
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(regressionsIdx).toBeGreaterThan(summaryIdx);
    expect(artifactsIdx).toBeGreaterThan(regressionsIdx);
    expect(comment).toContain('No performance regressions detected.');
    expect(comment).toContain('- [Full results JSON](./perfsense-results.json)');
  });

  it('does not expose confidence or internal correlation scores', () => {
    const result: CheckResult = {
      results: [makeEntry({ status: 'REGRESSION', deltaPercent: 159.4 })],
      summary: { pass: 0, warning: 0, regression: 1, failed: true },
      correlation: {
        metrics: {
          exportMIDITime: {
            regression: { metric: 'exportMIDITime', baselineMedian: 1000, currentMedian: 2594, deltaPercent: 159.4, pValue: 0.001, effectSize: 0.8, confidenceInterval: [2400, 2800] },
            evidence: [],
            likelyCause: makeCause(),
            filteredEvidence: 0,
          },
        },
        crossMetricCauses: [],
        summary: { totalRegressions: 1, metricsWithCause: 1, metricsInconclusive: 0 },
      },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).not.toContain('direct');
    expect(comment).not.toContain('strong');
    expect(comment).not.toContain('relevance');
    expect(comment).not.toContain('confidence');
    expect(comment).not.toContain('High');
    expect(comment).not.toContain('Low');
  });
});

describe('AI reasoning / root cause', () => {
  it('renders likely cause, function, line and evidence-based AI analysis', () => {
    const result: CheckResult = {
      results: [makeEntry({ status: 'REGRESSION', deltaPercent: 159.4, baselineMedian: 1678.6, currentMedian: 4354.2 })],
      summary: { pass: 0, warning: 0, regression: 1, failed: true },
      correlation: {
        metrics: {
          exportMIDITime: {
            regression: { metric: 'exportMIDITime', baselineMedian: 1678.6, currentMedian: 4354.2, deltaPercent: 159.4, pValue: 0.001, effectSize: 0.8, confidenceInterval: [4000, 4700] },
            evidence: [],
            likelyCause: makeCause(),
            filteredEvidence: 0,
          },
        },
        crossMetricCauses: [],
        summary: { totalRegressions: 1, metricsWithCause: 1, metricsInconclusive: 0 },
      },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('### exportMIDITime — +159.4%');
    expect(comment).toContain('**Likely cause:** `js/SaveInterface.js:42`');
    expect(comment).toContain('**Function:** afterSaveMIDI()');
    expect(comment).toContain('**AI analysis:**');
    expect(comment).toContain('on the code path measured by exportMIDITime');
    expect(comment).toContain('Scheduling delay increased (500ms → 2500ms)');
    expect(comment).toContain('consistent with the observed +159.4% slower result');
  });

  it('renders "No likely cause identified." when evidence is insufficient', () => {
    const result: CheckResult = {
      results: [makeEntry({ status: 'REGRESSION', deltaPercent: 50 })],
      summary: { pass: 0, warning: 0, regression: 1, failed: true },
      correlation: {
        metrics: {
          exportMIDITime: {
            regression: { metric: 'exportMIDITime', baselineMedian: 1000, currentMedian: 1500, deltaPercent: 50, pValue: 0.001, effectSize: 0.8, confidenceInterval: [1400, 1600] },
            evidence: [],
            likelyCause: null,
            filteredEvidence: 2,
          },
        },
        crossMetricCauses: [],
        summary: { totalRegressions: 1, metricsWithCause: 0, metricsInconclusive: 0 },
      },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('**Likely cause:** No likely cause identified.');
  });

  it('renders cross-metric shared causes instead of hiding them', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'RainbowConnection.html', metric: 'saveTime', status: 'REGRESSION', deltaPercent: 10.1 }),
        makeEntry({ page: 'RainbowConnection.html', metric: 'exportMIDITime', status: 'REGRESSION', deltaPercent: 159.4 }),
      ],
      summary: { pass: 0, warning: 0, regression: 2, failed: true },
      correlation: {
        metrics: {
          saveTime: { regression: { metric: 'saveTime', baselineMedian: 26.7, currentMedian: 29.4, deltaPercent: 10.1, pValue: 0.001, effectSize: 0.8, confidenceInterval: [26, 32] }, evidence: [], likelyCause: null, filteredEvidence: 0 },
          exportMIDITime: { regression: { metric: 'exportMIDITime', baselineMedian: 1000, currentMedian: 2594, deltaPercent: 159.4, pValue: 0.001, effectSize: 0.8, confidenceInterval: [2400, 2800] }, evidence: [], likelyCause: null, filteredEvidence: 0 },
        },
        crossMetricCauses: [
          {
            description: 'Git diff changes the metric\'s measured code path with a perf-sensitive change',
            source: 'js/SaveInterface.js:42',
            confidence: 'direct',
            affectedMetrics: ['saveTime', 'exportMIDITime'],
            evidenceIds: ['git-export'],
          },
        ],
        summary: { totalRegressions: 2, metricsWithCause: 0, metricsInconclusive: 0 },
      },
    };
    const comment = generatePRComment(result, PR_27);
    expect((comment.match(/js\/SaveInterface\.js:42/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(comment).toContain('shared across those metrics');
  });
});