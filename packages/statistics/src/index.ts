export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Sample standard deviation (n - 1 denominator). */
export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance =
    values.reduce((sum, v) => sum + (v - m) * (v - m), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Median absolute deviation — robust scatter estimate. */
export function mad(values: number[]): number {
  if (values.length === 0) return 0;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/**
 * Coefficient of variation (sample sd / mean). Undefined (returns Infinity)
 * for zero means so stability tiers fall to 'extreme' instead of dividing by
 * zero.
 */
export function coefficientOfVariation(values: number[]): number {
  const m = mean(values);
  if (m === 0) return Infinity;
  return stdDev(values) / Math.abs(m);
}

/** Jekyll stability tiers, indexed by coefficient of variation. */
export type StabilityTier = "stable" | "moderate" | "high" | "extreme";

export function stabilityTier(cv: number): StabilityTier {
  if (cv < 0.05) return "stable";
  if (cv < 0.15) return "moderate";
  if (cv < 0.3) return "high";
  return "extreme";
}

/** Pooled standard deviation of two independent samples. */
export function pooledStdDev(a: number[], b: number[]): number {
  const variance =
    ((a.length - 1) * stdDev(a) ** 2 + (b.length - 1) * stdDev(b) ** 2) /
    (a.length + b.length - 2);
  return Math.sqrt(Math.max(0, variance));
}

/**
 * Effect size of the median shift in units of pooled scatter. Infinity when
 * both samples are perfectly tight (pooled sd ≈ 0).
 */
export function effectZ(baseline: number[], current: number[]): number {
  const pooled = pooledStdDev(baseline, current);
  if (pooled === 0) return Infinity;
  return Math.abs(median(current) - median(baseline)) / pooled;
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
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
    t;
  return sign * (1 - poly * Math.exp(-a * a));
}

function normalCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function bootstrapCI(
  values: number[],
  nResamples = 1000,
  ciLevel = 0.95,
): [number, number] {
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
    medians.push(
      sample.length % 2 !== 0
        ? sample[mid]
        : (sample[mid - 1] + sample[mid]) / 2,
    );
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

  interface Item {
    value: number;
    group: number;
  }
  const all: Item[] = [
    ...baseline.map((v) => ({ value: v, group: 0 })),
    ...current.map((v) => ({ value: v, group: 1 })),
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

export interface ExactClassification {
  /** True when |currentMedian - baselineMedian| exceeds the tolerance. */
  changed: boolean;
  absDelta: number;
  baselineMedian: number;
  currentMedian: number;
  tolerance: number;
}

/**
 * Verdict for a fingerprint metric. Equality check, not a signed delta: any
 * deviation in either direction means the optimized code path moved.
 */
export function classifyExact(
  baseline: number[],
  current: number[],
  tolerance: number,
): ExactClassification {
  const baselineMedian = median(baseline);
  const currentMedian = median(current);
  const absDelta = currentMedian - baselineMedian;
  return {
    changed: Math.abs(absDelta) > tolerance,
    absDelta,
    baselineMedian,
    currentMedian,
    tolerance,
  };
}

export interface ClassificationResult {
  status: "pass" | "warning" | "regression";
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
  thresholds: {
    warning: number;
    fail: number;
    absEpsilon?: number;
    maxStatus?: "pass" | "warning";
  },
): ClassificationResult {
  const baselineMedian = median(baseline);
  const currentMedian = median(current);
  const deltaPercent =
    baselineMedian === 0
      ? currentMedian > 0
        ? 100
        : 0
      : ((currentMedian - baselineMedian) / baselineMedian) * 100;

  const absEpsilon = thresholds.absEpsilon ?? DEFAULT_ABS_EPSILON;
  const absDelta = currentMedian - baselineMedian;
  if (
    Math.abs(baselineMedian) < absEpsilon &&
    Math.abs(absDelta) < absEpsilon
  ) {
    return {
      status: "pass",
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

  let status: "pass" | "warning" | "regression";
  let details: string;

  if (enoughData && pValue !== null && effectSize !== null) {
    const significant =
      pValue < P_VALUE_THRESHOLD && effectSize >= EFFECT_SIZE_THRESHOLD;
    if (deltaPercent >= thresholds.fail && significant) {
      status = "regression";
      details =
        `delta=${deltaPercent.toFixed(1)}% exceeds fail threshold ${thresholds.fail}% ` +
        `and p=${pValue.toFixed(4)} < ${P_VALUE_THRESHOLD}, d=${effectSize.toFixed(2)} >= ${EFFECT_SIZE_THRESHOLD}`;
    } else if (deltaPercent >= thresholds.warning) {
      status = "warning";
      details =
        `delta=${deltaPercent.toFixed(1)}% exceeds warning threshold ${thresholds.warning}%` +
        ` (p=${pValue.toFixed(4)}, d=${effectSize.toFixed(2)})`;
    } else {
      status = "pass";
      details = `delta=${deltaPercent.toFixed(1)}% within thresholds`;
    }
  } else {
    if (deltaPercent >= thresholds.fail) {
      status = "regression";
      details = `delta=${deltaPercent.toFixed(1)}% exceeds fail threshold ${thresholds.fail}% (delta-only)`;
    } else if (deltaPercent >= thresholds.warning) {
      status = "warning";
      details = `delta=${deltaPercent.toFixed(1)}% exceeds warning threshold ${thresholds.warning}% (delta-only)`;
    } else {
      status = "pass";
      details = `delta=${deltaPercent.toFixed(1)}% within thresholds`;
    }
  }

  return capStatus(
    { status, deltaPercent, pValue, effectSize, confidenceInterval, details },
    thresholds.maxStatus,
  );
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
  maxStatus: "pass" | "warning" | undefined,
): ClassificationResult {
  if (maxStatus === "warning" && result.status === "regression") {
    return {
      ...result,
      status: "warning",
      details: result.details + ` [capped at warning by maxStatus]`,
    };
  }
  if (maxStatus === "pass" && result.status !== "pass") {
    return {
      ...result,
      status: "pass",
      details: result.details + ` [capped at pass by maxStatus]`,
    };
  }
  return result;
}

/** Six-state classification used by the PR report (superset of classifyRegression). */
export type ChangeStatus =
  | "pass"
  | "warning"
  | "regression"
  | "improvement"
  | "likely-noise"
  | "inconclusive";

export interface ChangeClassification {
  status: ChangeStatus;
  /** Null when the percentage is meaningless (near-zero baseline / noise floor). */
  deltaPercent: number | null;
  absDelta: number;
  pValue: number | null;
  effectSize: number | null;
  effectZ: number | null;
  confidenceInterval: [number, number] | null;
  baselineMedian: number;
  currentMedian: number;
  baselineCV: number | null;
  stabilityTier: StabilityTier | null;
  /** null when the baseline carries no environment fingerprint (legacy v1). */
  envMatched: boolean | null;
  baselineAgeDays: number | null;
  details: string;
}

export interface ChangeOptions {
  /** CV of the baseline distribution (read from baseline v2 stats when available). */
  baselineCV?: number | null;
  /** Whether the current run env matches the baseline env; null when unknown. */
  envMatched?: boolean | null;
  /** Baseline age in days when generated; null when unknown (legacy v1). */
  baselineAgeDays?: number | null;
  /** Maximum baseline age (days) at which improvements are trusted. */
  maxFreshDays?: number;
  /** Minimum |effectZ| (median shift in pooled-σ units) to trust an improvement. */
  minEffectZ?: number;
}

/**
 * Full six-state classifier used by the PR report.
 *
 * - Regressions/warnings reuse the exact `classifyRegression` contract
 *   (delta thresholds + Mann-Whitney p < 0.05 + |Cliff's δ| ≥ 0.147), and are
 *   never demoted by environment/staleness — those are reported as caveats.
 * - Improvements (negative delta) demand strictly more evidence: |delta| past
 *   the fail threshold, statistical significance, a ≥2σ pooled effect, a fresh
 *   baseline (≤ maxFreshDays), a matching environment fingerprint, and a
 *   non-extreme baseline CV (or ≥3σ when CV is extreme). Any failed gate lands
 *   in 'likely-noise' instead of green.
 * - Fewer than `MIN_RUNS` samples per group → 'inconclusive' (no verdict).
 */
export function classifyChange(
  baseline: number[],
  current: number[],
  thresholds: {
    warning: number;
    fail: number;
    absEpsilon?: number;
    maxStatus?: "pass" | "warning";
  },
  opts?: ChangeOptions,
): ChangeClassification {
  const maxFreshDays = opts?.maxFreshDays ?? 30;
  const minEffectZ = opts?.minEffectZ ?? 2;

  const common = {
    baselineMedian: median(baseline),
    currentMedian: median(current),
    baselineCV:
      opts?.baselineCV !== undefined
        ? opts.baselineCV
        : coefficientOfVariation(baseline),
    envMatched: opts?.envMatched !== undefined ? opts.envMatched : null,
    baselineAgeDays:
      opts?.baselineAgeDays !== undefined ? opts.baselineAgeDays : null,
  };
  const stability =
    common.baselineCV === null || !isFinite(common.baselineCV)
      ? null
      : stabilityTier(common.baselineCV);

  if (baseline.length === 0 || current.length === 0) {
    return {
      ...common,
      status: "inconclusive",
      deltaPercent: null,
      absDelta: 0,
      pValue: null,
      effectSize: null,
      effectZ: null,
      confidenceInterval: null,
      stabilityTier: stability,
      details: "no samples in baseline or current group",
    };
  }

  const absEpsilon = thresholds.absEpsilon ?? DEFAULT_ABS_EPSILON;
  const absDelta = common.currentMedian - common.baselineMedian;
  const rawDelta =
    common.baselineMedian === 0
      ? common.currentMedian > 0
        ? 100
        : 0
      : ((common.currentMedian - common.baselineMedian) /
          common.baselineMedian) *
        100;
  // A percentage is meaningless when the baseline sits at the measurement
  // noise floor (drift/lag residue, zeroed memory metrics), so the report
  // shows "—" instead of a fabricated number like "-6.6%." The classification
  // itself still uses `rawDelta` so a real 0 → large jump keeps regressing.
  const pctNull = Math.abs(common.baselineMedian) < absEpsilon;

  const enoughData = baseline.length >= MIN_RUNS && current.length >= MIN_RUNS;

  if (!enoughData) {
    return {
      ...common,
      status: "inconclusive",
      deltaPercent: pctNull ? null : rawDelta,
      absDelta,
      pValue: null,
      effectSize: null,
      effectZ: null,
      confidenceInterval: null,
      stabilityTier: stability,
      details: `${baseline.length}/${MIN_RUNS} baseline and ${current.length}/${MIN_RUNS} current valid runs; no verdict (needs ${MIN_RUNS}+ each)`,
    };
  }

  // Noise floor: the median shift itself is below measurement precision at any
  // baseline scale (identical runs, drift residue) — treat the percentage as
  // meaningless (null) and the result as pass.
  if (Math.abs(absDelta) < absEpsilon) {
    return {
      ...common,
      status: "pass",
      deltaPercent: null,
      absDelta,
      pValue: null,
      effectSize: null,
      effectZ: null,
      confidenceInterval: null,
      stabilityTier: stability,
      details: `median shift |delta|=${absDelta} below noise epsilon=${absEpsilon}; percentage set to null`,
    };
  }

  const pValue = mannWhitneyU(baseline, current);
  const effectSize = Math.abs(cliffsDelta(baseline, current));
  const confidenceInterval = bootstrapCI(current, 1000, 0.95);
  const z = effectZ(baseline, current);
  const significant =
    pValue < P_VALUE_THRESHOLD && effectSize >= EFFECT_SIZE_THRESHOLD;
  const failPct = thresholds.fail;
  const warnPct = thresholds.warning;

  let status: ChangeStatus;
  let details: string;

  if (absDelta >= 0) {
    // Slower or unchanged — reuse the existing regression contract verbatim.
    if (rawDelta >= failPct && significant) {
      status = "regression";
      details = `delta=${rawDelta.toFixed(1)}% >= fail ${failPct}%, p=${pValue.toFixed(4)}, d=${effectSize.toFixed(2)} (significant)`;
    } else if (rawDelta >= warnPct) {
      status = "warning";
      details = `delta=${rawDelta.toFixed(1)}% >= warning ${warnPct}% (p=${pValue.toFixed(4)}, d=${effectSize.toFixed(2)})`;
    } else {
      status = "pass";
      details = `delta=${rawDelta.toFixed(1)}% within thresholds`;
    }
    if (
      status !== "pass" &&
      stability === "extreme" &&
      common.baselineCV !== null
    ) {
      details += `; baseline CV ${(common.baselineCV * 100).toFixed(1)}% is extreme — treat as suspect`;
    }
  } else {
    // Improvement direction: every gate below must pass or the result is noise.
    const magnitudeReachedFail = -rawDelta >= failPct;
    const fresh =
      common.baselineAgeDays !== null && common.baselineAgeDays <= maxFreshDays;
    const envTrusted = common.envMatched === true;
    const stableEnough = stability !== "extreme" || z >= 3;
    const effectTrusted = z >= minEffectZ;

    if (
      magnitudeReachedFail &&
      significant &&
      fresh &&
      envTrusted &&
      stableEnough &&
      effectTrusted
    ) {
      status = "improvement";
      details =
        `statistically supported improvement: delta=${rawDelta.toFixed(1)}%, p=${pValue.toFixed(4)}, ` +
        `d=${effectSize.toFixed(2)}, effectZ=${z.toFixed(1)} (≥${minEffectZ}), ` +
        `baseline CV=${common.baselineCV !== null ? (common.baselineCV * 100).toFixed(1) + "%" : "n/a"}`;
    } else if (-rawDelta >= warnPct) {
      status = "likely-noise";
      details = `delta=${rawDelta.toFixed(1)}% is a likely-noise change from a ${common.baselineAgeDays !== null ? common.baselineAgeDays + " day old" : "unknown-age"} baseline`;
      const failures: string[] = [];
      if (!magnitudeReachedFail)
        failures.push(
          `|delta| ${Math.abs(rawDelta).toFixed(1)}% < fail ${failPct}%`,
        );
      if (!significant) failures.push("not statistically significant");
      if (!fresh) failures.push("baseline stale or unknown age");
      if (!envTrusted)
        failures.push("environment fingerprint unknown or mismatched");
      if (!stableEnough)
        failures.push("baseline CV extreme without ≥3σ effect");
      if (!effectTrusted)
        failures.push(`effectZ=${z.toFixed(1)} < ${minEffectZ}`);
      details += failures.length
        ? ` — not certified as improvement: ${failures.join("; ")}`
        : "";
    } else {
      status = "pass";
      details = `delta=${rawDelta.toFixed(1)}% within thresholds (improvement side)`;
    }
  }

  const base: ChangeClassification = {
    ...common,
    status,
    deltaPercent: pctNull ? null : rawDelta,
    absDelta,
    pValue,
    effectSize,
    effectZ: z,
    confidenceInterval,
    stabilityTier: stability,
    details,
  };

  if (thresholds.maxStatus === "warning" && status === "regression") {
    return {
      ...base,
      status: "warning",
      details: base.details + " [capped at warning by maxStatus]",
    };
  }
  if (
    thresholds.maxStatus === "pass" &&
    (status === "regression" || status === "warning")
  ) {
    return {
      ...base,
      status: "pass",
      details: base.details + " [capped at pass by maxStatus]",
    };
  }
  return base;
}
