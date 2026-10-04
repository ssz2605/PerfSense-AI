import { describe, it, expect } from 'vitest';
import { generatePRComment, type CheckResult, type CheckResultEntry } from './index';
import type { LikelyCause } from '@perfsense/correlation-engine';

const PR_27 = { pr: '27', head: 'c46d920', baselineRef: 'origin/master', matrix: 'Music Blocks Benchmark Matrix' };

function makeEntry(partial?: Partial<CheckResult['results'][number]>) {
  return {
    page: 'RainbowConnection.html',
    metric: 'saveTime',
    status: 'PASS' as const,
    deltaPercent: 0,
    absDelta: 0,
    baselineMedian: 1000,
    currentMedian: 1000,
    failThreshold: 10,
    pValue: null,
    effectSize: null,
    effectZ: null,
    confidenceInterval: null,
    baselineCV: null,
    stabilityTier: null,
    envMatched: null,
    baselineAgeDays: null,
    note: null,
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
      'The diff changes js/SaveInterface.js:42, which is on the code path measured by saveTime. ' +
      'The change is performance-sensitive: Scheduling delay increased (500ms → 2500ms). ' +
      'The change adds work or delay, which is consistent with the observed +159.4% slower result for saveTime.',
    causeEvidence: {
      file: 'js/SaveInterface.js',
      line: 42,
      function: 'afterSaveMIDI()',
      changeType: 'Scheduling delay increased (500ms → 2500ms)',
      direction: 'increased',
      metric: 'saveTime',
      deltaPercent: 159.4,
    },
    ...partial,
  };
}

function makeCorrelation(metric = 'saveTime', cause: LikelyCause | null = makeCause()): CheckResult['correlation'] {
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
        // Still collected, but retired from the contract.
        makeEntry({ page: 'Frere-Jacques.html', metric: 'executionTime', status: 'REGRESSION', deltaPercent: 9.9, baselineMedian: 100, currentMedian: 110 }),
        // Recursion depth belongs to the three fixtures that own it explicitly.
        makeEntry({ page: 'Frere-Jacques.html', metric: 'maxLogicalDepth', status: 'REGRESSION', deltaPercent: 5, baselineMedian: 10, currentMedian: 10.5 }),
        makeEntry({ page: 'Frere-Jacques.html', metric: 'maxActionDepth', status: 'REGRESSION', deltaPercent: 5, baselineMedian: 10, currentMedian: 10.5 }),
        // viewportCulledBlocks replaced the retired scheduleLag probes here.
        makeEntry({ page: 'crabcanon-plot.html', metric: 'viewportCulledBlocks', status: 'PASS', deltaPercent: -2, baselineMedian: 796, currentMedian: 780 }),
        // Retired from the crabcanon contract as constant-on-unchanged-code.
        makeEntry({ page: 'crabcanon-plot.html', metric: 'scheduleLagMean', status: 'PASS', deltaPercent: -2, baselineMedian: 12, currentMedian: 11.8 }),
        // Extra raw metric that is not part of the crabcanon matrix.
        makeEntry({ page: 'crabcanon-plot.html', metric: 'retainedHeap', status: 'REGRESSION', deltaPercent: 50, baselineMedian: 1000, currentMedian: 1500 }),
      ],
      summary: { pass: 2, warning: 0, regression: 4, failed: true },
    };
    const comment = generatePRComment(result, PR_27);

    expect(comment).toContain('callbackLatencyMean');
    expect(comment).toContain('viewportCulledBlocks');
    expect(comment).not.toContain('projectLoadTime');
    expect(comment).not.toContain('maxLogicalDepth');
    expect(comment).not.toContain('maxActionDepth');
    expect(comment).not.toContain('retainedHeap');
    // scheduleLagMean is no longer approved for crabcanon, so it must not
    // surface even though the run collected it.
    expect(comment).not.toContain('scheduleLagMean');
    // executionTime is only approved for musical-tree and the spiral, never for
    // Frère, so it must not surface here even though the run collected it.
    expect(comment).not.toContain('executionTime');
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
        makeEntry({ page: 'RainbowConnection.html', metric: 'refreshCanvasCallCount', status: 'PASS', deltaPercent: 0 }),
        makeEntry({ page: 'RainbowConnection.html', metric: 'saveTime', status: 'WARNING', deltaPercent: 12 }),
        makeEntry({ page: 'RainbowConnection.html', metric: 'projectLoadTime', status: 'REGRESSION', deltaPercent: 33.7 }),
        // A genuine classified improvement (not inferred from a negative delta).
        makeEntry({ page: 'RainbowConnection.html', metric: 'peakHeapDuringExport', status: 'IMPROVEMENT', deltaPercent: -20, currentMedian: 800 }),
      ],
      summary: { pass: 2, warning: 1, regression: 1, failed: true },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('🔴 Performance regression detected');
    expect(comment).toContain('| Rainbow Connection | 🔴 Regression |');
    // The full table still uses professional words.
    expect(comment).toContain('| No meaningful change |');
    expect(comment).toContain('| Warning |');
    expect(comment).toContain('| Regression |');
    expect(comment).toContain('| Improvement |');
  });

  it('reports a warning-only run as warning, not regression, and surfaces warnings in Details', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'Frere-Jacques.html', metric: 'callbackLatencyMean', status: 'WARNING', deltaPercent: 42, baselineMedian: 40, currentMedian: 56.8 }),
        makeEntry({ page: 'Frere-Jacques.html', metric: 'callbackLatencyMax', status: 'WARNING', deltaPercent: 18, baselineMedian: 1, currentMedian: 1.18 }),
      ],
      summary: { pass: 0, warning: 2, regression: 0, failed: false },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('🟠 No hard regression (warnings present)');
    expect(comment).toContain('| Frère Jacques | 🟠 Warning |');
    expect(comment).toContain('🟠 **callbackLatencyMean** — +42.0%');
    expect(comment).toContain('**Likely cause:** No likely cause identified.');
  });

  it('renders only notable fixtures in Details and passes through to the collapsible table', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'RainbowConnection.html', metric: 'refreshCanvasCallCount', status: 'PASS', deltaPercent: 0 }),
        makeEntry({ page: 'index.html', metric: 'bootstrapTotal', status: 'PASS', deltaPercent: 0 }),
      ],
      summary: { pass: 2, warning: 0, regression: 0, failed: false },
    };
    const comment = generatePRComment(result, PR_27);
    const details = comment.split('## Details')[1].split('<details')[0];
    expect(details).not.toContain('### Rainbow Connection');
    expect(details).toContain('No regressions or meaningful changes detected.');
    // Both fixtures still appear in the collapsible section.
    expect(comment).toContain('### Rainbow Connection');
    expect(comment).toContain('### index.html (bootstrap)');
  });

  it('filters retired maxDepth out of the report entirely', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'musical-tree.html', metric: 'maxDepth', status: 'REGRESSION', deltaPercent: 200, baselineMedian: 1, currentMedian: 3 }),
        makeEntry({ page: 'musical-tree.html', metric: 'executionTime', status: 'PASS', deltaPercent: 0 }),
      ],
      summary: { pass: 1, warning: 0, regression: 1, failed: true },
    };
    const comment = generatePRComment(result, PR_27);
    // maxDepth is no longer part of the approved matrix, so it never renders
    // (not even as Unverified) and cannot influence the overall verdict.
    expect(comment).not.toContain('maxDepth');
    expect(comment).toContain('| executionTime');
    expect(comment).toContain('🟢 No significant regression');
  });

  it('shows classified improvements as green detail blocks with statistical evidence', () => {
    const result: CheckResult = {
      results: [
        makeEntry({
          page: 'ascending-notes-color-spiral.html',
          metric: 'executionTime',
          status: 'IMPROVEMENT',
          deltaPercent: -12.3,
          baselineMedian: 743,
          currentMedian: 651.6,
          pValue: 0.02,
          effectSize: 0.5,
          effectZ: 2.4,
          baselineCV: 0.09,
          stabilityTier: 'moderate',
          envMatched: true,
          baselineAgeDays: 3,
        }),
      ],
      summary: { pass: 0, warning: 0, regression: 0, failed: false, improvement: 1 },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('| ascending-notes-color-spiral | 🟢 Improved |');
    expect(comment).toContain('🟢 **executionTime** — -12.3%');
    // A certified improvement shows evidence, not a fake "cause".
    expect(comment).toContain('**Evidence:**');
    expect(comment).toContain('p=0.0200, d=0.50, effectZ=2.40, baseline CV=9.0%');
    expect(comment).not.toContain('**Likely cause:**');
  });
});

describe('baseline provenance banner', () => {
  const withHarness = (state: 'match' | 'mismatch' | 'unknown', baselineRef: string | null, runRef: string | null): CheckResult => ({
    results: [makeEntry({ metric: 'bootstrapTotal', status: 'INCONCLUSIVE', deltaPercent: 29.8, note: 'harness mismatch' })],
    summary: { pass: 0, warning: 0, regression: 0, failed: false, inconclusive: 1 },
    baselineMeta: { envMatched: true, ageDays: 1, stale: false, hasEnv: true, harness: { baselineRef, runRef, state } },
  });

  it('blocks comparison outright when the baseline came from another harness', () => {
    const comment = generatePRComment(withHarness('mismatch', '53ae5d2', '8c57213'), PR_27);
    expect(comment).toContain('Baseline was captured with a different PerfSense revision');
    expect(comment).toContain('`53ae5d2`');
    expect(comment).toContain('`8c57213`');
    expect(comment).toContain('every verdict is withheld');
  });

  it('says nothing when both sides ran the same harness', () => {
    const comment = generatePRComment(withHarness('match', '8c57213', '8c57213'), PR_27);
    expect(comment).not.toContain('different PerfSense revision');
  });

  it('warns without blocking when the baseline recorded no revision', () => {
    const comment = generatePRComment(withHarness('unknown', null, '8c57213'), PR_27);
    expect(comment).toContain('Baseline records no PerfSense revision');
    expect(comment).not.toContain('every verdict is withheld');
  });

  it('stays silent when neither side is in the workflow', () => {
    const comment = generatePRComment(withHarness('unknown', null, null), PR_27);
    // No banner (that one is scoped to "the baseline is the stale side"), but
    // the verdict is still reported as uncertifiable: with neither side
    // fingerprinted there is nothing to certify comparability against.
    expect(comment).not.toContain('Baseline records no PerfSense revision');
    expect(comment).toContain('uncertifiable');
  });

  it('renders nothing when no harness metadata is supplied at all', () => {
    const result: CheckResult = {
      results: [makeEntry({})],
      summary: { pass: 1, warning: 0, regression: 0, failed: false },
      baselineMeta: { envMatched: null, ageDays: null, stale: false, hasEnv: false },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).not.toContain('PerfSense revision');
    expect(comment).toContain('legacy v1');
  });
});

describe('baseline certification', () => {
  const certifiedResult = (over: Partial<CheckResultEntry> = {}): CheckResult => ({
    results: [makeEntry({ page: 'index.html', metric: 'bootstrapTotal', status: 'WARNING', deltaPercent: 29.8, ...over })],
    summary: { pass: 0, warning: 1, regression: 0, failed: false },
    baselineMeta: {
      envMatched: true,
      ageDays: 1,
      stale: false,
      hasEnv: true,
      comparisonCertified: true,
      uncertifiableReasons: [],
      harness: { baselineRef: '8c57213', runRef: '8c57213', state: 'match' },
    },
  });

  it('certifies a matching harness with an environment fingerprint', () => {
    const comment = generatePRComment(certifiedResult(), PR_27);
    expect(comment).not.toContain('uncertifiable');
    expect(comment).toContain('| bootstrapTotal |');
    expect(comment).not.toContain('uncertified');
  });

  it('marks a mismatched harness uncertifiable', () => {
    const result = certifiedResult();
    result.baselineMeta = {
      ...result.baselineMeta!,
      comparisonCertified: false,
      uncertifiableReasons: ['the baseline used a different PerfSense revision'],
      harness: { baselineRef: '53ae5d2', runRef: '8c57213', state: 'mismatch' },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('every verdict is withheld');
    expect(comment).toContain('uncertifiable');
  });

  it('marks a legacy baseline uncertifiable', () => {
    const result = certifiedResult();
    // Both the metadata and the entry carry the state: the reporter marks a row
    // from the row itself, so a meta-only flag would leave the table unmarked.
    result.results[0].comparisonCertified = false;
    result.baselineMeta = {
      ...result.baselineMeta!,
      hasEnv: false,
      comparisonCertified: false,
      uncertifiableReasons: [
        'the baseline records no PerfSense revision',
        'the baseline has no environment fingerprint (legacy v1 schema)',
      ],
      harness: { baselineRef: null, runRef: '8c57213', state: 'unknown' },
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('Baseline records no PerfSense revision');
    expect(comment).toContain('legacy v1');
    expect(comment).toContain('Every verdict in this report is uncertifiable');
    // The regression is still displayed - it is a real measurement - but it is
    // labelled so it cannot be read as an actionable finding.
    expect(comment).toContain('**bootstrapTotal** — +29.8% · uncertified');
    expect(comment).toContain('Warning · uncertified');
  });

  it('does not mark PASS rows uncertified, only rows that assert a verdict', () => {
    const result = certifiedResult({ status: 'PASS', deltaPercent: 1.2 });
    result.results[0].comparisonCertified = false;
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('| No meaningful change |');
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
    const fullIdx = comment.indexOf('<details');
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
      correlation: makeCorrelation('saveTime', makeCause()),
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('🔴 **saveTime** — +159.4%');
    expect(comment).toContain('**Likely cause:** `js/SaveInterface.js:42`');
    expect(comment).toContain('**Function:** afterSaveMIDI()');
    expect(comment).toContain('**AI analysis:**');
    expect(comment).toContain('on the code path measured by saveTime');
    expect(comment).toContain('Scheduling delay increased (500ms → 2500ms)');
    expect(comment).toContain('consistent with the observed +159.4% slower result');
  });

  it('renders "No likely cause identified." when evidence is insufficient', () => {
    const result: CheckResult = {
      results: [makeEntry({ status: 'REGRESSION', deltaPercent: 50 })],
      summary: { pass: 0, warning: 0, regression: 1, failed: true },
      correlation: makeCorrelation('saveTime', null),
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).toContain('**Likely cause:** No likely cause identified.');
  });

  it('renders the per-metric AI explanation instead of "No likely cause identified."', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'index.html', metric: 'bootstrapTotal', status: 'REGRESSION', deltaPercent: 39.8, baselineMedian: 5370.5, currentMedian: 7508.7 }),
      ],
      summary: { pass: 0, warning: 0, regression: 1, failed: true },
      correlation: makeCorrelation('bootstrapTotal', null),
    };
    const comment = generatePRComment(result, {
      ...PR_27,
      aiPerMetric: {
        bootstrapTotal: 'The 2000ms loader deferral in js/loader.js delays bootstrapTotal by ~2000ms, matching the +39.8% increase.',
      },
    });
    expect(comment).not.toContain('**Likely cause:** No likely cause identified.');
    expect(comment).toContain('**AI analysis:**');
    expect(comment).toContain('The 2000ms loader deferral in js/loader.js delays bootstrapTotal by ~2000ms');
  });

  it('keeps "No likely cause identified." when the per-metric AI text is missing', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'index.html', metric: 'bootstrapTotal', status: 'REGRESSION', deltaPercent: 39.8, baselineMedian: 5370.5, currentMedian: 7508.7 }),
      ],
      summary: { pass: 0, warning: 0, regression: 1, failed: true },
      correlation: makeCorrelation('bootstrapTotal', null),
    };
    const comment = generatePRComment(result, { ...PR_27, aiPerMetric: {} });
    expect(comment).toContain('**Likely cause:** No likely cause identified.');
  });

  it('renders a top-level AI analysis section when aiAnalysis is provided', () => {
    const result: CheckResult = {
      results: [makeEntry({ status: 'REGRESSION', deltaPercent: 159.4 })],
      summary: { pass: 0, warning: 0, regression: 1, failed: true },
      correlation: makeCorrelation('saveTime', null),
    };
    const comment = generatePRComment(result, { ...PR_27, aiAnalysis: 'The 2000ms loader deferral in js/loader.js delays bootstrapTotal by ~2000ms.' });
    expect(comment).toContain('<summary>AI analysis</summary>');
    expect(comment).toContain('The 2000ms loader deferral in js/loader.js delays bootstrapTotal by ~2000ms.');
  });

  it('omits the AI analysis section when aiAnalysis is not provided', () => {
    const result: CheckResult = {
      results: [makeEntry({ status: 'REGRESSION', deltaPercent: 159.4 })],
      summary: { pass: 0, warning: 0, regression: 1, failed: true },
      correlation: makeCorrelation('saveTime', null),
    };
    const comment = generatePRComment(result, PR_27);
    expect(comment).not.toContain('<summary>AI analysis</summary>');
  });

  it('renders cross-metric shared causes instead of hiding them', () => {
    const result: CheckResult = {
      results: [
        makeEntry({ page: 'RainbowConnection.html', metric: 'saveTime', status: 'REGRESSION', deltaPercent: 10.1 }),
        makeEntry({ page: 'RainbowConnection.html', metric: 'projectLoadTime', status: 'REGRESSION', deltaPercent: 159.4 }),
      ],
      summary: { pass: 0, warning: 0, regression: 2, failed: true },
      correlation: {
        metrics: {
          saveTime: { regression: { metric: 'saveTime', baselineMedian: 26.7, currentMedian: 29.4, deltaPercent: 10.1, pValue: 0.001, effectSize: 0.8, confidenceInterval: [26, 32] }, evidence: [], likelyCause: null, filteredEvidence: 0 },
          projectLoadTime: { regression: { metric: 'projectLoadTime', baselineMedian: 1000, currentMedian: 2594, deltaPercent: 159.4, pValue: 0.001, effectSize: 0.8, confidenceInterval: [2400, 2800] }, evidence: [], likelyCause: null, filteredEvidence: 0 },
        },
        crossMetricCauses: [
          {
            description: 'Git diff changes the metric\'s measured code path with a perf-sensitive change',
            source: 'js/SaveInterface.js:42',
            confidence: 'direct',
            affectedMetrics: ['saveTime', 'projectLoadTime'],
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