import path from 'path';
import fs from 'fs';
import type { PageResult, BaselineData, BaselineMetricStatsV2, StabilityTier } from '@perfsense/core';
import { median, percentile, mean, stdDev, mad, coefficientOfVariation, stabilityTier } from '@perfsense/statistics';
import { isKnownFixture, isMetricApproved } from '@perfsense/benchmark-matrix';
import { computeEnvironmentFingerprint, resolveBaselineHarness } from './env';
import { runValidate } from './validate';

function printUsage(): void {
  console.log(
    'Usage:\n' +
    '  perfsense baseline save --from <results.json> --out <baseline.json> [--commit <sha>] [--warmup <n>]\n' +
    '  perfsense baseline load --file <baseline.json>\n' +
      '  perfsense baseline validate --baseline <file> [--previous <file>] [--config <file>] [--format json]\n'
  );
}

function getMetricNames(runs: PageResult['runs']): string[] {
  const names = new Set<string>();
  for (const run of runs) {
    for (const key of Object.keys(run.metrics)) {
      names.add(key);
    }
  }
  return Array.from(names);
}

function collectValues(runs: PageResult['runs'], metric: string): number[] {
  return runs
    .map((r) => r.metrics[metric])
    .filter((v): v is number => typeof v === 'number');
}

/** Jekyll CV tiers for the stability field in v2 baselines. */
function tierOf(cv: number): StabilityTier {
  if (cv < 0.05) return 'stable';
  if (cv < 0.15) return 'moderate';
  if (cv < 0.3) return 'high';
  return 'extreme';
}

function computeStats(values: number[]): BaselineMetricStatsV2 {
  const n = values.length;
  const m = mean(values);
  const sd = stdDev(values);
  const cv = m === 0 ? Infinity : sd / Math.abs(m);
  const tier = tierOf(cv);
  return {
    median: median(values),
    p10: percentile(values, 10),
    p90: percentile(values, 90),
    mean: m,
    sd,
    mad: mad(values),
    min: Math.min(...values),
    max: Math.max(...values),
    p25: percentile(values, 25),
    p75: percentile(values, 75),
    cv,
    n,
    invalid: 0,
    values,
    stability: {
      tier,
      flagged: tier === 'high' || tier === 'extreme',
      note:
        tier === 'stable' ? 'low variance: reliable for improvement certification'
          : tier === 'moderate' ? 'moderate variance: improvements need ≥2σ pooled effect'
            : tier === 'high' ? 'high variance: improvements demoted to likely-noise unless ≥3σ'
              : 'extreme variance: improvements demoted to likely-noise unless ≥3σ; investigate measurement method',
    },
  };
}

export function save(argv: string[]): void {
  let fromFile = 'results.json';
  let outFile = 'baseline.json';
  let commitSHA: string | undefined;
  let warmup = 0;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from' && i + 1 < argv.length) {
      fromFile = argv[++i];
    } else if (argv[i] === '--out' && i + 1 < argv.length) {
      outFile = argv[++i];
    } else if (argv[i] === '--commit' && i + 1 < argv.length) {
      commitSHA = argv[++i];
    } else if (argv[i] === '--warmup' && i + 1 < argv.length) {
      warmup = parseInt(argv[++i], 10) || 0;
    }
  }

  const resultsPath = path.resolve(fromFile);
  if (!fs.existsSync(resultsPath)) {
    console.error(`Error: results file not found: ${resultsPath}`);
    process.exit(1);
  }

  const results: PageResult[] = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
  const runsCount = results.length > 0 ? results[0].runs.length : 0;

  const pages: BaselineData['pages'] = {};

  for (const pageResult of results) {
    // The Benchmark Matrix is the source of truth. Fixtures outside the matrix
    // and metric/fixture combinations it does not approve are rejected at
    // baseline-save time so stale or unauthorized entries never enter the
    // committed baseline.
    if (!isKnownFixture(pageResult.page)) {
      console.warn(`Skipping page "${pageResult.page}": not in Benchmark Matrix`);
      continue;
    }

    const metricNames = getMetricNames(pageResult.runs).filter((m) =>
      isMetricApproved(pageResult.page, m),
    );
    const pageMetrics: Record<string, BaselineMetricStatsV2> = {};

    for (const metric of metricNames) {
      const values = collectValues(pageResult.runs, metric);
      if (values.length === 0) continue;
      pageMetrics[metric] = computeStats(values);
    }

    pages[pageResult.page] = pageMetrics;
  }

  const now = new Date();
  const baseline: BaselineData = {
    schema: 'perfsense-baseline-v2',
    schemaVersion: 2,
    createdAt: now.toISOString(),
    generatedAt: now.toISOString(),
    runs: runsCount,
    warmup,
    pages,
    source: fromFile,
    commitSHA,
    // Which harness produced this file. Stamped from the workflow-level
    // PERFSENSE_REF so a later comparison can refuse to read across two
    // different revisions of the measuring code.
    harness: resolveBaselineHarness(),
    env: computeEnvironmentFingerprint(),
  };

  const outPath = path.resolve(outFile);
  fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2));
  console.log(`Saved baseline to ${outPath}`);
}

export function load(argv: string[]): void {
  let file = 'baseline.json';

  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--file' || argv[i] === '-f') && i + 1 < argv.length) {
      file = argv[++i];
    }
  }

  const filePath = path.resolve(file);
  if (!fs.existsSync(filePath)) {
    console.error(`Error: baseline file not found: ${filePath}`);
    process.exit(1);
  }

  const baseline: BaselineData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  console.log(`Schema:    ${baseline.schema}`);
  console.log(`Created:   ${baseline.createdAt}`);
  console.log(`Runs:      ${baseline.runs}`);
  console.log(`Source:    ${baseline.source}\n`);

  for (const [pageName, metrics] of Object.entries(baseline.pages)) {
    console.log(`--- ${pageName} ---`);
    for (const [metricName, stats] of Object.entries(metrics)) {
      console.log(`  ${metricName}: median=${stats.median.toFixed(1)}ms  p10=${stats.p10.toFixed(1)}ms  p90=${stats.p90.toFixed(1)}ms  (${stats.values.length} runs)`);
    }
    console.log();
  }
}

export function run(argv: string[]): void {
  if (argv.length === 0) {
    printUsage();
    process.exit(0);
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (subcommand === 'save') {
    save(rest);
  } else if (subcommand === 'load') {
    load(rest);
  } else if (subcommand === 'validate') {
    // A non-zero exit is the point: the workflow runs this between saving and
    // committing so an untrustworthy capture never reaches the baseline branch.
    process.exit(runValidate(rest));
  } else {
    console.error(`Unknown baseline subcommand: ${subcommand}`);
    printUsage();
    process.exit(1);
  }
}
