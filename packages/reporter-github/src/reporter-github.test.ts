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

function makeCorrelation(metric = 'exportMIDITime', cause: LikelyCause | null = makeCause()): CheckResult['correlation'] {
  return {
    metrics: {
      [metric]: {
        regression: { metric, baselineMedian: 1000, currentMedian: 2594, deltaPercent: 159.4, pValue: 0.001, effectSize: 0.8, confidenceInterval: [2400, 2800] },
        evidence: [],
        likelyCause: cause,
        filteredEvidence: 0,
      },
    },
    crossMetricCauses: [],
    summary: { totalRegressions: 1, metricsWithCause: cause ? 1 : 0, metricsInconclusive: 0 },
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

  it('groups every fixture row in the summary and metrics under their fixture', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'RainbowConnection.html', metric: 'projectLoadTime', status: 'PASS', deltaPercent: 0, baselineMedian: 8959, currentMedian: 8959 }),
        makeEntry({ page: 'index.html', metric: 'bootstrapTotal', status: 'PASS', deltaPercent: 0, baselineMedian: 5370, currentMedian: 5370 }),
      ],
      summary: { pass: 2, warning: 0, regression: 0, failed: false },
    };
    const comment = generatePRComment(result, PR_27);
    // Summary lists both fixtures (matrix order: index.html first).
    const indexSummary = comment.indexOf('| index.html (bootstrap) | ✅ Passed |');
    const rainbowSummary = comment.indexOf('| Rainbow Connection | ✅ Passed |');
    expect(indexSummary).toBeGreaterThan(-1);
    expect(rainbowSummary).toBeGreaterThan(indexSummary);
    // Metrics stay under their own fixture in the collapsible table.
    const collapsible = comment.split('<summary>All approved metrics</summary>')[1];
    const indexSection = collapsible.split('### index.html (bootstrap)')[1].split('###')[0];
    expect(indexSection).toContain('bootstrapTotal');
    const rainbowSection = collapsible.split('### Rainbow Connection')[1].split('###')[0];
    expect(rainbowSection).toContain('projectLoadTime');
    expect(indexSection).not.toContain('projectLoadTime');
    expect(rainbowSection).not.toContain('bootstrapTotal');
  });
});

describe('summary statuses and compact details', () => {
  it('uses emoji indicators in the overall line and summary rows, text statuses in tables', () => {
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
    expect(comment).toContain('🔴 Performance regression detected');
    expect(comment).toContain('| Rainbow Connection | 🔴 Regression |');
    // The full table still uses professional words.
    expect(comment).toContain('| Passed |');
    expect(comment).toContain('| Warning |');
    expect(comment).toContain('| Regression |');
    expect(comment).toContain('| Improved |');
  });

  it('reports a warning-only run as no significant regression', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'Frere-Jacques.html', metric: 'callbackLatencyMean', status: 'WARNING', deltaPercent: 42, baselineMedian: 40, currentMedian: 56.8 }),
        makeEntry({ page: 'Frere-Jacques.html', metric: 'cumulativeDrift', status: 'WARNING', deltaPercent: 18, baselineMedian: 1, currentMedian: 1.18 }),
      ],
      summary: { pass: 0, warning: 2, regression: 0, failed: false },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('🟡 No significant regression');
    expect(comment).toContain('| Frère Jacques | 🟡 Warning |');
    // Warnings are surfaced in the summary but not as detail blocks.
    expect(comment).toContain('No regressions or meaningful improvements detected.');
  });

  it('renders only notable fixtures in Details and passes through to the collapsible table', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'RainbowConnection.html', metric: 'exportMIDITime', status: 'PASS', deltaPercent: 0 }),
        makeEntry({ page: 'index.html', metric: 'bootstrapTotal', status: 'PASS', deltaPercent: 0 }),
      ],
      summary: { pass: 2, warning: 0, regression: 0, failed: false },
    };
    const comment = generatePRComment(result, PR_27);
    const details = comment.split('## Details')[1].split('<details>')[0];
    expect(details).not.toContain('### Rainbow Connection');
    expect(details).toContain('No regressions or meaningful improvements detected.');
    // Both fixtures still appear in the collapsible section.
    expect(comment).toContain('### Rainbow Connection');
    expect(comment).toContain('### index.html (bootstrap)');
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
    // Not treated as a genuine regression: no detail block, no red overall.
    expect(comment).not.toContain('### maxDepth');
    expect(comment).toContain('🟢 No significant regression');
  });

  it('shows meaningful improvements as green detail blocks', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'ascending-notes-color-spiral.html', metric: 'executionTime', status: 'PASS', deltaPercent: -12.3, baselineMedian: 743, currentMedian: 651.6 }),
      ],
      summary: { pass: 1, warning: 0, regression: 0, failed: false },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('| ascending-notes-color-spiral | 🟢 Improved |');
    expect(comment).toContain('🟢 **executionTime** — -12.3%');
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
    const checkIdx = comment.indexOf('## Performance Check');
    const detailsIdx = comment.indexOf('## Details');
    const fullIdx = comment.indexOf('<details>');
    const artifactsIdx = comment.indexOf('## Artifacts');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(detailsIdx).toBeGreaterThan(checkIdx);
    expect(fullIdx).toBeGreaterThan(detailsIdx);
    expect(artifactsIdx).toBeGreaterThan(fullIdx);
    expect(comment).toContain('🟢 No significant regression');
    expect(comment).toContain('- [Full results JSON](./perfsense-results.json)');
  });

  it('does not expose confidence or internal correlation scores', () => {
    const result: CheckResult = {
      results: [makeEntry({ status: 'REGRESSION', deltaPercent: 159.4 })],
      summary: { pass: 0, warning: 0, regression: 1, failed: true },
      correlation: makeCorrelation(),
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
      correlation: makeCorrelation('exportMIDITime', makeCause()),
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('🔴 **exportMIDITime** — +159.4%');
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
      correlation: makeCorrelation('exportMIDITime', null),
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