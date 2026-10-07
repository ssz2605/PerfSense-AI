import fs from 'fs';
import type {
  BaselineData,
  BaselineDefect,
  BaselineMetricStatsV2,
  BaselineValidity,
  ValidityConfig,
} from '@perfsense/core';
import { median } from '@perfsense/statistics';
import { BENCHMARK_MATRIX, isMetricApproved, getMetricUnit, getFixtureContract } from '@perfsense/benchmark-matrix';
import { environmentsMatch } from './env';
import { loadConfig } from './report';

/**
 * Defaults for the baseline validity gate. Deliberately narrow in scope: the
 * gate only rejects a capture on evidence it can defend — too few samples, two
 * distinct clusters in the sample, a configured spread limit exceeded, or a
 * runner that was CPU-constrained while measuring. Everything else is a
 * warning, because a warning that blocks a refresh is indistinguishable from no
 * gate at all.
 */
export const VALIDITY_DEFAULTS = {
  minSamples: 5,
  /** One picosecond in milliseconds: below this a probe cannot resolve a change. */
  resolutionFloor: 1e-6,
  bimodalGapRatio: 6,
  bimodalShiftPct: 10,
  maxDivergencePct: 10,
  rejectThrottled: true,
  /**
   * Observed spread at which a metric with no configured limit becomes worth
   * mentioning. Without this floor a clean capture of twenty-eight tight
   * metrics produces twenty-eight identical warnings, which trains the reader
   * to ignore the one warning that matters.
   */
  spreadNoticePct: 2,
} as const;

export interface BimodalSplit {
  /** Largest consecutive gap divided by the median of the remaining gaps. */
  gapRatio: number;
  /** Distance between the two cluster medians, as a percentage of the lower one. */
  shiftPct: number;
  bimodal: boolean;
}

/**
 * Looks for two clusters in a sample. Pure and exported so the rule can be
 * tested against known-good and known-corrupt captures.
 *
 * The signal is a single gap far larger than the rest. `gapRatio` alone is not
 * enough — a smooth ramp of six samples produces a largest gap only mildly
 * above the others — so the split also has to separate the two medians by a
 * meaningful amount. That second condition is what keeps ordinary jitter out of
 * the failure path.
 */
export function detectBimodality(
  values: number[],
  gapRatioMin: number,
  shiftPctMin: number,
): BimodalSplit | null {
  if (values.length < 4) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) gaps.push(sorted[i + 1] - sorted[i]);

  let maxGap = -Infinity;
  let gapIndex = 0;
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i] > maxGap) {
      maxGap = gaps[i];
      gapIndex = i;
    }
  }

  const others = gaps.filter((_, i) => i !== gapIndex).sort((a, b) => a - b);
  const otherMedian = median(others);
  // All remaining gaps zero means one clean step and no noise anywhere else:
  // unboundedly strong evidence, so report it as such rather than dividing.
  const gapRatio = otherMedian > 0 ? maxGap / otherMedian : maxGap > 0 ? Infinity : 0;

  const left = sorted.slice(0, gapIndex + 1);
  const right = sorted.slice(gapIndex + 1);
  if (left.length < 2 || right.length < 2) {
    return { gapRatio, shiftPct: 0, bimodal: false };
  }

  const leftMedian = median(left);
  const rightMedian = median(right);
  const shiftPct =
    leftMedian === 0 ? (rightMedian === 0 ? 0 : Infinity) : Math.abs((rightMedian - leftMedian) / leftMedian) * 100;

  return { gapRatio, shiftPct, bimodal: gapRatio >= gapRatioMin && shiftPct >= shiftPctMin };
}

function fmtPct(value: number): string {
  if (!isFinite(value)) return '∞';
  return `${value.toFixed(2)}%`;
}

function fmtGapRatio(value: number): string {
  if (!isFinite(value)) return '∞';
  return `${value.toFixed(1)}x`;
}

/** Readable sample value in the audit table, without exponential form for ordinary magnitudes. */
function fmtNum(value: number): string {
  if (!isFinite(value)) return String(value);
  if (Math.abs(value) >= 1e6 || (Math.abs(value) > 0 && Math.abs(value) < 1e-4)) {
    return value.toExponential(3);
  }
  return value.toFixed(4).replace(/\.?0+$/, '');
}

/** `(p90 - p10) / median` as a percentage. Null when the median cannot express a ratio. */
function spreadPercent(stats: BaselineMetricStatsV2): number | null {
  if (!isFinite(stats.median) || stats.median === 0) return null;
  return ((stats.p90 - stats.p10) / Math.abs(stats.median)) * 100;
}

/**
 * Smallest spread percentage an integer-count metric can express, or null for
 * a continuous metric.
 *
 * A count cannot move in fractions, so at a median of 8 one unit is already
 * 12.5% and a p10→p90 span of two units is 25%. A percentage limit set below
 * that floor is not a noise tolerance at all: it fires on a single rounding
 * step. That is the same reasoning as the continuous resolution floor, applied
 * to the metric's own unit — a metric that cannot express the difference must
 * not be failed for expressing it.
 */
function quantizationFloorPct(metric: string, stats: BaselineMetricStatsV2): number | null {
  if (getMetricUnit(metric) !== 'count') return null;
  if (!isFinite(stats.median) || stats.median === 0) return null;
  // Two units, because p10 and p90 straddle the median and so differ by at
  // least one step on each side.
  return (2 / Math.abs(stats.median)) * 100;
}

export interface ValidateOptions {
  /** Baseline currently on record, for the same-commit divergence check. */
  previous?: BaselineData;
  validity?: ValidityConfig;
}

function addExerciseDefect(
  defects: BaselineDefect[],
  fixture: string,
  metric: string,
  stats: BaselineMetricStatsV2 | undefined,
  invalid: (stats: BaselineMetricStatsV2) => boolean,
  detail: string,
): void {
  if (!stats || !invalid(stats)) return;
  defects.push({
    fixture,
    metric,
    kind: "zero-variance",
    severity: "fail",
    detail,
  });
}

/**
 * Audits a freshly captured baseline and reports every defect that would make
 * it unsafe to compare against. The output is a list, not a boolean: the caller
 * decides what to block on, and the human gets the evidence either way.
 */
export function validateBaseline(
  baseline: BaselineData,
  options: ValidateOptions = {},
): BaselineValidity {
  const cfg = { ...VALIDITY_DEFAULTS, ...options.validity };
  const limits = options.validity?.maxSpreadPct ?? {};
  const defects: BaselineDefect[] = [];
  let metricCount = 0;

  // A capture taken on a CPU-constrained runner is not comparable to anything:
  // every metric inflates together, which reads as a project-wide regression.
  const throttle = baseline.env?.cpuQuota;
  if (cfg.rejectThrottled && throttle?.throttled === true) {
    defects.push({
      fixture: '*',
      metric: null,
      kind: 'spread',
      severity: 'fail',
      detail:
        `capture ran on a CPU-constrained runner (quota ${throttle.quotaCpus} cores vs ` +
        `${baseline.env?.cores} visible); every metric from this run is inflated. ` +
        'Re-capture on an unconstrained runner.',
    });
  }

  const frere = baseline.pages["Frere-Jacques.html"];
  addExerciseDefect(
    defects,
    "Frere-Jacques.html",
    "transportEventCount",
    frere && findCell(frere, "transportEventCount"),
    stats => stats.median === 0 || stats.values.some(value => value === 0),
    "transport seam not exercised in this environment",
  );

  const rainbow = baseline.pages["RainbowConnection.html"];
  // No "unexercised" guard on refreshCanvasCallCount: its healthy value on CI is
  // 0, which is the entire point of PR #7923 (_suppressRefresh stops the load
  // repainting). A "== 0 means never exercised" test therefore rejected a
  // correct capture — baseline run #22 failed validate on exactly this, and the
  // message ("project refresh path not exercised") described the opposite of
  // what had happened. "Did the wrapper install at all?" is answered by the
  // collector instead: readPerfsense reports null rather than 0 when the
  // wrapper never latched, and the required-metric gate fails that loudly.
  addExerciseDefect(
    defects,
    "RainbowConnection.html",
    "maxDepth",
    rainbow && findCell(rainbow, "maxDepth"),
    stats => stats.median < 2 || stats.values.some(value => value < 2),
    "headless export fast-run path not exercised in this environment",
  );

  for (const contract of BENCHMARK_MATRIX) {
    const page = baseline.pages[contract.fixture];
    if (!page) {
      defects.push({
        fixture: contract.fixture,
        metric: null,
        kind: 'missing-fixture',
        severity: 'warn',
        detail: `contract requires this fixture but the capture contains no samples for it`,
      });
      continue;
    }

    for (const metric of contract.metrics) {
      const stats = findCell(page, metric);
      if (!stats) {
        defects.push({
          fixture: contract.fixture,
          metric,
          kind: 'missing-metric',
          severity: 'warn',
          detail: `approved metric has no baseline cell; comparisons for it will report NO_BASELINE`,
        });
        continue;
      }
      metricCount++;

      if (stats.n < cfg.minSamples) {
        defects.push({
          fixture: contract.fixture,
          metric,
          kind: 'insufficient-samples',
          severity: 'fail',
          detail: `${stats.n} valid samples; classification requires ${cfg.minSamples}`,
        });
      }

      const spread = spreadPercent(stats);
      const inert = stats.median === 0;
      // Tested after `inert`: a median of exactly 0 is a probe that measured
      // nothing, which is a stronger and more actionable finding than "the
      // number is small".
      const belowResolution = !inert && isFinite(stats.median) && Math.abs(stats.median) < cfg.resolutionFloor;

      if (inert) {
        defects.push({
          fixture: contract.fixture,
          metric,
          kind: 'zero-variance',
          severity: 'warn',
          detail: `median is 0 across all ${stats.n} samples; the probe produced no signal`,
        });
      } else if (belowResolution) {
        defects.push({
          fixture: contract.fixture,
          metric,
          kind: 'below-resolution',
          severity: 'warn',
          detail:
            `median ${stats.median.toExponential(2)} is below the ${cfg.resolutionFloor} resolution ` +
            'floor; this probe cannot show a meaningful change either way',
        });
      }

      // A probe that cannot resolve a change is not also asked to have a tight
      // distribution. Demanding both would fail every capture over a metric
      // that is already reported as incapable.
      if (belowResolution || inert) continue;

      const limit = limits[metric];
      const quantFloor = quantizationFloorPct(metric, stats);
      // A count metric whose limit sits under its own quantization floor cannot
      // be gated by that limit: the limit is finer than one unit, so it fires on
      // rounding. That applies to the bimodality test too — splitting 8|10 is one
      // unit, not two measurement conditions. Reported rather than silently
      // passed, so the misconfiguration stays visible.
      if (limit !== undefined && quantFloor !== null && limit < quantFloor) {
        if (spread === null || spread <= quantFloor) continue;
        defects.push({
          fixture: contract.fixture,
          metric,
          kind: 'spread',
          severity: 'warn',
          detail:
            `observed spread ${fmtPct(spread)} exceeds the configured limit of ${limit}%, but that ` +
            `limit is below this metric's quantization floor of ${fmtPct(quantFloor)} ` +
            `(median ${fmtNum(stats.median)}); not gated`,
        });
        continue;
      }

      const split = detectBimodality(stats.values, cfg.bimodalGapRatio, cfg.bimodalShiftPct);
      if (split?.bimodal) {
        defects.push({
          fixture: contract.fixture,
          metric,
          kind: 'bimodal',
          severity: 'fail',
          detail:
            `samples form two clusters (gap ${fmtGapRatio(split.gapRatio)} the median gap, ` +
            `cluster medians ${fmtPct(split.shiftPct)} apart); the run was not measured under ` +
            'one condition',
        });
      }

      if (spread === null) continue;
      if (limit === undefined) {
        if (spread < cfg.spreadNoticePct) continue;
        defects.push({
          fixture: contract.fixture,
          metric,
          kind: 'spread',
          severity: 'warn',
          detail:
            `observed spread ${fmtPct(spread)} (p10 ${fmtNum(stats.p10)} → p90 ` +
            `${fmtNum(stats.p90)}); no maxSpreadPct configured, so it is not gated`,
        });
      } else if (spread > limit) {
        defects.push({
          fixture: contract.fixture,
          metric,
          kind: 'spread',
          severity: 'fail',
          detail:
            `observed spread ${fmtPct(spread)} exceeds the configured limit of ${limit}% ` +
            `(p10 ${fmtNum(stats.p10)} → p90 ${fmtNum(stats.p90)}); ` +
            're-capture on a quiet runner',
        });
      }
    }

    // Cells the matrix does not approve. `baseline save` filters these out, so
    // finding one means the file predates a contract change — and nothing will
    // ever read it again.
    for (const metric of Object.keys(page)) {
      if (isMetricApproved(contract.fixture, metric)) continue;
      defects.push({
        fixture: contract.fixture,
        metric,
        kind: 'orphan-cell',
        severity: 'warn',
        detail:
          'baseline holds a cell this fixture no longer collects; it is never compared and is ' +
          'invisible to the coverage table',
      });
    }
  }

  let comparedWithPrevious = false;
  if (options.previous) {
    comparedWithPrevious = true;
    defects.push(...divergenceDefects(baseline, options.previous, cfg.maxDivergencePct));
  }

  return {
    ok: !defects.some((d) => d.severity === 'fail'),
    defects,
    comparedWithPrevious,
    fixtureCount: Object.keys(baseline.pages).length,
    metricCount,
  };
}

/**
 * Movement against the baseline being replaced. Only runs when the two captures
 * share an app commit and a matching environment, because only then is the
 * movement attributable to the measurement conditions rather than to a code
 * change — which is the entire reason to re-capture. If the commit moved, no
 * verdict is issued; the human sees the medians and decides.
 */
function divergenceDefects(
  baseline: BaselineData,
  previous: BaselineData,
  maxPct: number,
): BaselineDefect[] {
  const defects: BaselineDefect[] = [];
  // `commitSHA` is canonical; `commitSha` is the stamp step's alias. Accept
  // both so a stamped baseline still matches instead of silently skipping the
  // divergence check for having no readable commit.
  const baselineCommit = baseline.commitSHA ?? baseline.commitSha;
  const previousCommit = previous.commitSHA ?? previous.commitSha;
  const sameCommit = !!baselineCommit && baselineCommit === previousCommit;
  const sameEnv =
    !!baseline.env && !!previous.env && environmentsMatch(previous.env, baseline.env);
  if (!sameCommit || !sameEnv) return defects;

  for (const [fixture, page] of Object.entries(baseline.pages)) {
    const prevPage = previous.pages[fixture];
    if (!prevPage) continue;
    for (const [metric, stats] of Object.entries(page)) {
      const prev = findCell(prevPage, metric);
      if (!prev || prev.median === 0) continue;
      const changePct = ((stats.median - prev.median) / Math.abs(prev.median)) * 100;
      if (Math.abs(changePct) <= maxPct) continue;
      defects.push({
        fixture,
        metric,
        kind: 'divergence',
        severity: 'fail',
        detail:
          `median moved ${fmtPct(changePct)} (${fmtNum(prev.median)} → ` +
          `${fmtNum(stats.median)}) against the previous baseline of the same commit on ` +
          'a matching runner; the earlier capture is the suspect one',
      });
    }
  }
  return defects;
}

function findCell(page: BaselineData['pages'][string], metric: string): BaselineMetricStatsV2 | undefined {
  const key = Object.keys(page).find((k) => k.toLowerCase() === metric.toLowerCase());
  return key ? page[key] : undefined;
}

/** Human-readable audit report for the workflow log and the CLI. */
export function renderValidity(baseline: BaselineData, validity: BaselineValidity): string {
  const lines: string[] = [];
  const harness = baseline.harness;
  lines.push('## Baseline validity');
  lines.push('');
  lines.push(
    `Capture: ${validity.fixtureCount} fixture(s), ${validity.metricCount} metric cell(s), ` +
      `runs=${baseline.runs}, harness=${harness?.ref ?? `unavailable (${harness?.reason ?? 'not recorded'})`}`,
  );
  const throttle = baseline.env?.cpuQuota;
  if (throttle) {
    // `null` cores means "no limit found", which is not the same claim as
    // "no limit exists" — say which one this is.
    const quota =
      throttle.quotaCpus === null
        ? throttle.source === 'unavailable'
          ? 'unknown'
          : 'unrestricted'
        : `${throttle.quotaCpus} cores`;
    lines.push(`Runner CPU quota: ${quota} (${throttle.source}), throttled=${throttle.throttled}`);
  }
  if (baseline.env?.loadAvg1m !== undefined) {
    lines.push(`Runner 1-minute load average at capture: ${baseline.env.loadAvg1m}`);
  }
  if (validity.comparedWithPrevious) {
    lines.push('Compared against the previous baseline on the same commit and runner.');
  }
  lines.push('');

  if (validity.defects.length === 0) {
    lines.push('No defects found.');
    return lines.join('\n');
  }

  lines.push('| | Fixture | Metric | Defect | Detail |');
  lines.push('|---|---|---|---|---|');
  for (const d of validity.defects) {
    lines.push(
      `| ${d.severity === 'fail' ? '❌' : '⚠️'} | ${d.fixture} | ${d.metric ?? '—'} | ${d.kind} | ${d.detail} |`,
    );
  }
  lines.push('');
  const fails = validity.defects.filter((d) => d.severity === 'fail').length;
  const warns = validity.defects.length - fails;
  lines.push(
    fails > 0
      ? `**${fails} blocking defect(s), ${warns} warning(s).** The baseline was not committed.`
      : `${warns} warning(s), no blocking defects. The baseline can be committed.`,
  );
  return lines.join('\n');
}

/** CLI entry: `perfsense baseline validate --baseline <file> [--previous <file>]`. */
export function runValidate(argv: string[]): number {
  let baselinePath: string | undefined;
  let previousPath: string | undefined;
  let configPath: string | undefined;
  let formatJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--baseline') baselinePath = argv[++i];
    else if (arg === '--previous') previousPath = argv[++i];
    else if (arg === '--config') configPath = argv[++i];
    else if (arg === '--format') formatJson = argv[++i] === 'json';
  }

  if (!baselinePath) {
    console.error('Usage: perfsense baseline validate --baseline <file> [--previous <file>]');
    return 2;
  }

  let baseline: BaselineData;
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  } catch (err) {
    console.error(`Could not read baseline at ${baselinePath}: ${(err as Error).message}`);
    return 2;
  }

  let previous: BaselineData | undefined;
  if (previousPath) {
    try {
      previous = JSON.parse(fs.readFileSync(previousPath, 'utf-8'));
    } catch (err) {
      console.error(`Could not read previous baseline at ${previousPath}: ${(err as Error).message}`);
      return 2;
    }
  }

  const config = loadConfig(configPath);
  const validity = validateBaseline(baseline, { previous, validity: config?.validity });

  // Required fingerprint cells must be present in the baseline file itself.
  // Save already refuses to write one without them, but a baseline produced
  // before that gate existed (or edited by hand) can still be missing them, and
  // validate is the last step before the file is committed. Reuse the same
  // predicate so the two commands cannot disagree.
  const baselinePages = Object.entries(baseline.pages ?? {});
  const requiredMissing: { fixture: string; metric: string }[] = [];
  for (const [pageName, metrics] of baselinePages) {
    const contract = getFixtureContract(pageName);
    if (!contract || !contract.requiredMetrics) continue;
    for (const metric of contract.requiredMetrics) {
      const cell = (metrics as Record<string, unknown>)[metric];
      const hasValue =
        cell !== undefined &&
        cell !== null &&
        typeof (cell as { values?: unknown }).values === 'object' &&
        Array.isArray((cell as { values?: unknown }).values) &&
        (cell as { values: unknown[] }).values.some((v) => typeof v === 'number' && Number.isFinite(v));
      if (!hasValue) requiredMissing.push({ fixture: pageName, metric });
    }
  }

  if (requiredMissing.length > 0) {
    console.error(
      `Baseline is missing ${requiredMissing.length} required fingerprint cell(s):`,
    );
    for (const miss of requiredMissing) {
      console.error(`  REQUIRED MISSING (${miss.fixture}/${miss.metric})`);
    }
    console.error(
      '  These cells prove a merged optimization was measured. Without them the\n' +
        '  baseline cannot certify those code paths.',
    );
    if (formatJson) {
      console.log(
        JSON.stringify(
          {
            ...validity,
            ok: false,
            requiredMissing: requiredMissing.map((m) => `${m.fixture}/${m.metric}`),
          },
          null,
          2,
        ),
      );
    }
    return 1;
  }

  if (formatJson) {
    console.log(JSON.stringify(validity, null, 2));
  } else {
    console.log(renderValidity(baseline, validity));
  }
  return validity.ok ? 0 : 1;
}
