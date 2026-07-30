import path from 'path';
import fs from 'fs';
import type { PageResult, BaselineData } from '@perfsense/core';
import { median, percentile } from '@perfsense/statistics';

function printUsage(): void {
  console.log(
    'Usage:\n' +
    '  perfsense baseline save --from <results.json> --out <baseline.json>\n' +
    '  perfsense baseline load --file <baseline.json>\n'
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
    .filter((v): v is number => v !== null);
}

export function save(argv: string[]): void {
  let fromFile = 'results.json';
  let outFile = 'baseline.json';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from' && i + 1 < argv.length) {
      fromFile = argv[++i];
    } else if (argv[i] === '--out' && i + 1 < argv.length) {
      outFile = argv[++i];
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
    const metricNames = getMetricNames(pageResult.runs);
    const pageMetrics: Record<string, { median: number; p10: number; p90: number; values: number[] }> = {};

    for (const metric of metricNames) {
      const values = collectValues(pageResult.runs, metric);
      if (values.length === 0) continue;
      pageMetrics[metric] = {
        median: median(values),
        p10: percentile(values, 10),
        p90: percentile(values, 90),
        values,
      };
    }

    pages[pageResult.page] = pageMetrics;
  }

  const baseline: BaselineData = {
    schema: 'perfsense-baseline-v1',
    createdAt: new Date().toISOString(),
    runs: runsCount,
    pages,
    source: fromFile,
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
  } else {
    console.error(`Unknown baseline subcommand: ${subcommand}`);
    printUsage();
    process.exit(1);
  }
}
