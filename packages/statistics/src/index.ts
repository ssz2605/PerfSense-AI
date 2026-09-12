export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (index - lo) * (sorted[hi] - sorted[lo]);
}

function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const poly = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-a * a));
}

function normalCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function bootstrapCI(values: number[], nResamples = 1000, ciLevel = 0.95): [number, number] {
  if (values.length < 2) {
    const m = values.length === 1 ? values[0] : 0;
    return [m, m];
  }
  const medians: number[] = [];
  for (let i = 0; i < nResamples; i++) {
    let sum = 0;
    const sample: number[] = [];
    for (let j = 0; j < values.length; j++) {
      sample.push(values[Math.floor(Math.random() * values.length)]);
    }
    sample.sort((a, b) => a - b);
    const mid = Math.floor(sample.length / 2);
    medians.push(sample.length % 2 !== 0 ? sample[mid] : (sample[mid - 1] + sample[mid]) / 2);
  }
  medians.sort((a, b) => a - b);
  const alpha = 1 - ciLevel;
  const lo = Math.floor((alpha / 2) * nResamples);
  const hi = Math.ceil((1 - alpha / 2) * nResamples);
  return [medians[Math.max(0, lo)], medians[Math.min(nResamples - 1, hi - 1)]];
}

export function mannWhitneyU(baseline: number[], current: number[]): number {
  const n1 = baseline.length;
  const n2 = current.length;
  if (n1 === 0 || n2 === 0) return 1;

  interface Item { value: number; group: number; }
  const all: Item[] = [
    ...baseline.map(v => ({ value: v, group: 0 })),
    ...current.map(v => ({ value: v, group: 1 })),
  ];
  all.sort((a, b) => a.value - b.value);

  const ranks: number[] = new Array(all.length);
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j].value === all[i].value) j++;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) ranks[k] = avgRank;
    i = j;
  }

  let R1 = 0;
  for (let k = 0; k < all.length; k++) {
    if (all[k].group === 0) R1 += ranks[k];
  }

  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);
  const meanU = (n1 * n2) / 2;
  const sigmaU = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);

  if (sigmaU === 0) return 1.0;
  const z = (U - meanU) / sigmaU;
  return 2 * (1 - normalCDF(Math.abs(z)));
}

export function cliffsDelta(baseline: number[], current: number[]): number {
  if (baseline.length === 0 || current.length === 0) return 0;
  let greater = 0;
  let less = 0;
  for (const b of baseline) {
    for (const c of current) {
      if (c > b) greater++;
      if (c < b) less++;
    }
  }
  return (greater - less) / (baseline.length * current.length);
}

export interface ClassificationResult {
  status: 'pass' | 'warning' | 'regression';
  deltaPercent: number;
  pValue: number | null;
  effectSize: number | null;
  confidenceInterval: [number, number] | null;
  details: string;
}

/** Minimum number of runs per group before a statistical verdict is computed. */
export const MIN_RUNS = 5;
/** Minimum |Cliff's delta| an effect must reach to be considered meaningful. */
export const EFFECT_SIZE_THRESHOLD = 0.147;
/** Maximum p-value accepted as "statistically significant" (two-sided). */
export const P_VALUE_THRESHOLD = 0.05;
/**
 * Default absolute noise floor (in metric units) for the zero-baseline rule.
 *
 * Relative deltas are meaningless when both medians sit below measurement
 * precision (e.g. cumulativeDrift values around 1e-13, all-zero queue/memory
 * counters): complete separation of two noise distributions then yields
 * p<0.05, |d|=1 and an absurd percent delta (+200% on 0.0 vs 0.0), which
 * previously posted as REGRESSION on no-change PRs. Callers may override
 * per metric via thresholds.absEpsilon.
 */
export const DEFAULT_ABS_EPSILON = 1e-9;

export function classifyRegression(
  baseline: number[],
  current: number[],
  thresholds: { warning: number; fail: number; absEpsilon?: number; maxStatus?: 'pass' | 'warning' }
): ClassificationResult {
  const baselineMedian = median(baseline);
  const currentMedian = median(current);
  const deltaPercent = baselineMedian === 0
    ? (currentMedian > 0 ? 100 : 0)
    : ((currentMedian - baselineMedian) / baselineMedian) * 100;

  const absEpsilon = thresholds.absEpsilon ?? DEFAULT_ABS_EPSILON;
  const absDelta = currentMedian - baselineMedian;
  if (Math.abs(baselineMedian) < absEpsilon && Math.abs(absDelta) < absEpsilon) {
    return {
      status: 'pass',
      deltaPercent,
      pValue: null,
      effectSize: null,
      confidenceInterval: null,
      details: `both medians below noise floor (|baseline|=${baselineMedian}, |delta|=${absDelta} < epsilon=${absEpsilon}); treated as no change`,
    };
  }
  let pValue: number | null = null;
  let effectSize: number | null = null;
  let confidenceInterval: [number, number] | null = null;
  const enoughData = baseline.length >= MIN_RUNS && current.length >= MIN_RUNS;

  if (enoughData) {
    pValue = mannWhitneyU(baseline, current);
    effectSize = Math.abs(cliffsDelta(baseline, current));
    confidenceInterval = bootstrapCI(current, 1000, 0.95);
  }

  let status: 'pass' | 'warning' | 'regression';
  let details: string;

  if (enoughData && pValue !== null && effectSize !== null) {
    const significant = pValue < P_VALUE_THRESHOLD && effectSize >= EFFECT_SIZE_THRESHOLD;
    if (deltaPercent >= thresholds.fail && significant) {
      status = 'regression';
      details = `delta=${deltaPercent.toFixed(1)}% exceeds fail threshold ${thresholds.fail}% ` +
        `and p=${pValue.toFixed(4)} < ${P_VALUE_THRESHOLD}, d=${effectSize.toFixed(2)} >= ${EFFECT_SIZE_THRESHOLD}`;
    } else if (deltaPercent >= thresholds.warning) {
      status = 'warning';
      details = `delta=${deltaPercent.toFixed(1)}% exceeds warning threshold ${thresholds.warning}%` +
        ` (p=${pValue.toFixed(4)}, d=${effectSize.toFixed(2)})`;
    } else {
      status = 'pass';
      details = `delta=${deltaPercent.toFixed(1)}% within thresholds`;
    }
  } else {
    if (deltaPercent >= thresholds.fail) {
      status = 'regression';
      details = `delta=${deltaPercent.toFixed(1)}% exceeds fail threshold ${thresholds.fail}% (delta-only)`;
    } else if (deltaPercent >= thresholds.warning) {
      status = 'warning';
      details = `delta=${deltaPercent.toFixed(1)}% exceeds warning threshold ${thresholds.warning}% (delta-only)`;
    } else {
      status = 'pass';
      details = `delta=${deltaPercent.toFixed(1)}% within thresholds`;
    }
  }

  return capStatus({ status, deltaPercent, pValue, effectSize, confidenceInterval, details }, thresholds.maxStatus);
}

/**
 * Caps a classification at a ceiling status. This is how metrics with
 * unproven probes (queue depth, memory, drift) stay visible as warnings
 * without ever posting REGRESSION: astronomical relative deltas from
 * zero/residue baselines would otherwise sail past any finite fail
 * threshold (e.g. residue 5e-13 -> 5 reads as +1e15%).
 */
function capStatus(
  result: ClassificationResult,
  maxStatus: 'pass' | 'warning' | undefined
): ClassificationResult {
  if (maxStatus === 'warning' && result.status === 'regression') {
    return {
      ...result,
      status: 'warning',
      details: result.details + ` [capped at warning by maxStatus]`
    };
  }
  if (maxStatus === 'pass' && result.status !== 'pass') {
    return {
      ...result,
      status: 'pass',
      details: result.details + ` [capped at pass by maxStatus]`
    };
  }
  return result;
}
