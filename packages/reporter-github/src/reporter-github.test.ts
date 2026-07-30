import { describe, it, expect } from 'vitest';
import { generatePRComment } from './index';
import type { CheckResult } from './index';

const mockCheckResult: CheckResult = {
  results: [
    { page: 'test', metric: 'LCP', status: 'REGRESSION', deltaPercent: 15.3, baselineMedian: 1850, currentMedian: 2134, failThreshold: 10 },
    { page: 'test', metric: 'FCP', status: 'PASS', deltaPercent: 1.9, baselineMedian: 420, currentMedian: 428, failThreshold: 10 },
  ],
  summary: { pass: 1, warning: 0, regression: 1, failed: true },
};

describe('generatePRComment', () => {
  it('contains the report header', () => {
    const comment = generatePRComment(mockCheckResult);
    expect(comment).toContain('PerfSense AI - Performance Report');
  });

  it('contains a summary table', () => {
    const comment = generatePRComment(mockCheckResult);
    expect(comment).toContain('| Metric | Baseline | Current | Delta | Status |');
    expect(comment).toContain('LCP');
    expect(comment).toContain('FCP');
  });

  it('shows regression entries with details', () => {
    const comment = generatePRComment(mockCheckResult);
    expect(comment).toContain(':x:');
    expect(comment).toContain('LCP');
    expect(comment).toContain('+15.3%');
  });

  it('includes AI analysis section when provided', () => {
    const comment = generatePRComment(mockCheckResult, 'This is an AI analysis');
    expect(comment).toContain('<summary>AI Analysis</summary>');
    expect(comment).toContain('This is an AI analysis');
  });

  it('does not include AI section when not provided', () => {
    const comment = generatePRComment(mockCheckResult);
    expect(comment).not.toContain('<summary>AI Analysis</summary>');
  });

  it('includes artifacts section', () => {
    const comment = generatePRComment(mockCheckResult);
    expect(comment).toContain('<summary>Artifacts</summary>');
  });

  it('handles no regressions gracefully', () => {
    const passResult: CheckResult = {
      results: [{ page: 'test', metric: 'FCP', status: 'PASS', deltaPercent: 1, baselineMedian: 400, currentMedian: 404, failThreshold: 10 }],
      summary: { pass: 1, warning: 0, regression: 0, failed: false },
    };
    const comment = generatePRComment(passResult);
    expect(comment).toContain('No regressions detected.');
  });

  it('includes source location and blame when present', () => {
    const resultWithCorrelation: CheckResult = {
      ...mockCheckResult,
      correlation: {
        metrics: {
          lcp: {
            regression: { metric: 'LCP', baselineMedian: 1850, currentMedian: 2134, deltaPercent: 15.3, pValue: 0.01, effectSize: 0.8, confidenceInterval: [2000, 2200] },
            evidence: [],
            likelyCause: {
              description: 'Layout recalculation took 312ms',
              source: 'Stage.ts:142',
              confidence: 'direct' as any,
              evidenceIds: ['trace-1'],
              sourceLocation: { originalFile: 'src/components/Stage.ts', originalLine: 142, originalColumn: 5, minifiedFile: 'bundle.js', minifiedLine: 1056, confidence: 'exact' as any },
              blame: { commit: 'a1b2c3d4e5f6', author: 'shrey', email: 'shrey@test.com', date: '2026-01-01', message: 'Add animated block transitions', line: 142, confidence: 'exact' as any },
            },
            filteredEvidence: 0,
          },
        },
        crossMetricCauses: [],
        summary: { totalRegressions: 1, metricsWithCause: 1, metricsInconclusive: 0 },
      },
    };
    const comment = generatePRComment(resultWithCorrelation);
    expect(comment).toContain('src/components/Stage.ts:142');
    expect(comment).toContain('a1b2c3d');
    expect(comment).toContain('@shrey');
    expect(comment).toContain('Add animated block transitions');
  });

  it('includes cross-metric causes', () => {
    const resultWithCross: CheckResult = {
      ...mockCheckResult,
      correlation: {
        metrics: {
          lcp: { regression: { metric: 'LCP', baselineMedian: 1850, currentMedian: 2134, deltaPercent: 15.3, pValue: 0.01, effectSize: 0.8, confidenceInterval: [2000, 2200] }, evidence: [], likelyCause: null, filteredEvidence: 0 },
          fcp: { regression: { metric: 'FCP', baselineMedian: 420, currentMedian: 480, deltaPercent: 14.3, pValue: 0.01, effectSize: 0.7, confidenceInterval: [450, 500] }, evidence: [], likelyCause: null, filteredEvidence: 0 },
        },
        crossMetricCauses: [
          { description: 'Layout recalculation affects both LCP and FCP', source: 'Stage.ts:142', confidence: 'direct' as any, affectedMetrics: ['lcp', 'fcp'], evidenceIds: ['trace-1'] },
        ],
        summary: { totalRegressions: 2, metricsWithCause: 0, metricsInconclusive: 0 },
      },
    };
    const comment = generatePRComment(resultWithCross);
    expect(comment).toContain('Cross-Metric Causes');
    expect(comment).toContain('Layout recalculation affects both LCP and FCP');
  });
});
