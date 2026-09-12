import { describe, it, expect } from 'vitest';
import { median, percentile, bootstrapCI, mannWhitneyU, cliffsDelta, classifyRegression } from './index';

describe('median', () => {
  it('odd length', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('even length', () => {
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('single element', () => {
    expect(median([42])).toBe(42);
  });

  it('empty array', () => {
    expect(median([])).toBeNaN();
  });
});

describe('percentile', () => {
  const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('median (p50)', () => {
    expect(percentile(data, 50)).toBeCloseTo(5.5, 1);
  });

  it('minimum (p0)', () => {
    expect(percentile(data, 0)).toBe(1);
  });

  it('maximum (p100)', () => {
    expect(percentile(data, 100)).toBe(10);
  });

  it('p10', () => {
    const val = percentile(data, 10);
    expect(val).toBeGreaterThanOrEqual(1);
    expect(val).toBeLessThanOrEqual(2);
  });

  it('p90', () => {
    const val = percentile(data, 90);
    expect(val).toBeGreaterThanOrEqual(9);
    expect(val).toBeLessThanOrEqual(10);
  });
});

describe('bootstrapCI', () => {
  it('returns a valid interval containing the median', () => {
    const data = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const [lo, hi] = bootstrapCI(data, 500, 0.95);
    expect(lo).toBeLessThanOrEqual(hi);
    expect(lo).toBeGreaterThanOrEqual(10);
    expect(hi).toBeLessThanOrEqual(100);
  });

  it('narrows with more data', () => {
    const narrow = [10, 10, 10, 11, 11, 11, 10, 10, 10, 11];
    const wide = [1, 100, 2, 99, 3, 98, 4, 97, 5, 96];
    const [nLo, nHi] = bootstrapCI(narrow, 500, 0.95);
    const [wLo, wHi] = bootstrapCI(wide, 500, 0.95);
    expect(nHi - nLo).toBeLessThan(wHi - wLo);
  });
});

describe('mannWhitneyU', () => {
  it('returns high p for identical groups', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const b = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(mannWhitneyU(a, b)).toBeGreaterThan(0.9);
  });

  it('returns low p for clearly separated groups', () => {
    const small = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const big = [110, 120, 130, 140, 150, 160, 170, 180, 190, 200];
    expect(mannWhitneyU(small, big)).toBeLessThan(0.01);
  });

  it('returns 1.0 when one group is empty', () => {
    expect(mannWhitneyU([], [1, 2, 3])).toBe(1);
  });

  it('handles small groups', () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    const p = mannWhitneyU(a, b);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.5);
  });
});

describe('cliffsDelta', () => {
  it('returns 0 for identical groups', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [1, 2, 3, 4, 5];
    expect(cliffsDelta(a, b)).toBeCloseTo(0, 1);
  });

  it('returns ~1 when all current > all baseline', () => {
    const a = [1, 2, 3, 4, 5];
    const b = [10, 20, 30, 40, 50];
    expect(cliffsDelta(a, b)).toBeGreaterThan(0.9);
  });

  it('returns negative when baseline > current', () => {
    const a = [10, 20, 30];
    const b = [1, 2, 3];
    expect(cliffsDelta(a, b)).toBeLessThan(0);
  });
});

describe('classifyRegression', () => {
  const thresholds = { warning: 10, fail: 20 };

  it('passes for small delta (improvement)', () => {
    const result = classifyRegression([100, 100, 100, 100, 100, 100], [90, 90, 90, 90, 90, 90], thresholds);
    expect(result.status).toBe('pass');
  });

  it('regression for delta > fail with large effect size', () => {
    const baseline = [100, 100, 100, 100, 100, 100];
    const current = [200, 200, 200, 200, 200, 200];
    const result = classifyRegression(baseline, current, thresholds);
    expect(result.status).toBe('regression');
    expect(result.pValue).toBeLessThan(0.05);
    expect(result.effectSize).toBeGreaterThan(0.9);
  });

  it('warning for delta > warning but not statistically significant', () => {
    const baseline = [100, 101, 99, 100, 102, 98, 100, 101, 99, 100];
    const current = baseline.map(v => v + 15);
    const result = classifyRegression(baseline, current, { warning: 5, fail: 20 });
    expect(result.status).toBe('warning');
  });

  it('falls back to delta-only for N < 6', () => {
    const baseline = [100, 100, 100];
    const current = [200, 200, 200];
    const result = classifyRegression(baseline, current, thresholds);
    expect(result.status).toBe('regression');
    expect(result.pValue).toBeNull();
    expect(result.effectSize).toBeNull();
  });

  it('runs the statistical check at N = MIN_RUNS (5)', () => {
    const result = classifyRegression([100, 100, 100, 100, 100], [200, 200, 200, 200, 200], thresholds);
    expect(result.pValue).not.toBeNull();
    expect(result.effectSize).not.toBeNull();
    expect(result.status).toBe('regression');
  });

  it('requires both p-value and effect size for a regression (AND rule)', () => {
    // Median regresses 21% (over the 20% fail threshold) but the distributions
    // overlap heavily, so the Mann-Whitney p stays above 0.05.
    const result = classifyRegression(
      [100, 100, 100, 100, 100],
      [60, 120, 121, 122, 130],
      { warning: 5, fail: 20 }
    );
    expect(result.status).toBe('warning');
    expect(result.pValue).toBeGreaterThan(0.05);
  });
});

describe('classifyRegression zero-baseline / noise-floor rule', () => {
  it('0 -> 0 passes', () => {
    const result = classifyRegression([0, 0, 0, 0, 0], [0, 0, 0, 0, 0], { warning: 10, fail: 20 });
    expect(result.status).toBe('pass');
  });

  it('0 -> tiny noise passes (below epsilon)', () => {
    const result = classifyRegression([0, 0, 0, 0, 0], [1e-12, 2e-12, 1e-12, 3e-12, 2e-12], { warning: 10, fail: 20 });
    expect(result.status).toBe('pass');
  });

  it('0 -> 5 is warning-only under demoted fail thresholds, never regression', () => {
    const result = classifyRegression([0, 0, 0, 0, 0], [5, 5, 5, 5, 5], { warning: 10, fail: 10000 });
    expect(result.status).toBe('warning');
  });

  it('0 -> 100 with normal fail threshold and separated groups is regression', () => {
    const result = classifyRegression([0, 0, 0, 0, 0], [100, 100, 100, 100, 100], { warning: 10, fail: 20 });
    expect(result.status).toBe('regression');
    expect(result.pValue).not.toBeNull();
  });

  it('x -> 0 (improvement) passes', () => {
    const result = classifyRegression([100, 100, 100, 100, 100], [0, 0, 0, 0, 0], { warning: 10, fail: 20 });
    expect(result.status).toBe('pass');
  });

  it('epsilon-scale baseline -> normal value follows the normal rule (capped warn-only when demoted)', () => {
    const baseline = [5.6e-13, 5.6e-13, 1.4e-12, 1.1e-13, 2.2e-13];
    const demoted = { warning: 10, fail: 10000, maxStatus: 'warning' as const };
    const result = classifyRegression(baseline, [5, 5, 5, 5, 5], demoted);
    expect(result.status).toBe('warning');
    expect(result.details).toContain('maxStatus');
  });

  it('maxStatus caps an otherwise-significant regression at warning', () => {
    const result = classifyRegression(
      [100, 100, 100, 100, 100],
      [200, 200, 200, 200, 200],
      { warning: 10, fail: 20, maxStatus: 'warning' }
    );
    expect(result.status).toBe('warning');
  });

  it('zero baseline with insufficient samples still respects the noise floor', () => {
    const result = classifyRegression([0, 0, 0], [0, 0, 0], { warning: 10, fail: 20 });
    expect(result.status).toBe('pass');
    expect(result.pValue).toBeNull();
  });

  it('live #15 false positive is killed: drift residue distributions pass', () => {
    // Baseline medians ~5.7e-13 vs current ~1.7e-12 complete separation
    // previously yielded p<0.05, |d|=1, +200% -> REGRESSION on a no-change PR.
    const baseline = [5.68e-13, 5.68e-13, 1.47e-12, 1.13e-13, 2.27e-13];
    const current = [1.7e-12, 1.8e-12, 1.6e-12, 1.75e-12, 1.65e-12];
    const result = classifyRegression(baseline, current, { warning: 30, fail: 10000 });
    expect(result.status).toBe('pass');
    expect(result.details).toContain('noise floor');
  });

  it('custom absEpsilon override is honored', () => {
    const result = classifyRegression([0, 0, 0, 0, 0], [0.5, 0.5, 0.5, 0.5, 0.5], { warning: 10, fail: 20, absEpsilon: 1 });
    expect(result.status).toBe('pass');
  });
});
