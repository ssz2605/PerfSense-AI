import path from 'path';
import fs from 'fs';
import { BenchmarkDriver } from '@perfsense/driver-playwright';
import { LCP, FCP, TTFB } from '@perfsense/metrics-core';
import { PlaybackLatency, AudioDrift, StageUpdateTime, BlockThroughput, ProjectLoadTime } from '@perfsense/metrics-musicblocks';
import { median } from '@perfsense/statistics';
import type { MetricPlugin } from '@perfsense/core';

interface ConfigFile {
  pages?: string[];
  runs?: number;
  metrics?: string[];
  thresholds?: Record<string, { warning: number; fail: number }>;
}

const ALL_PLUGINS: Record<string, new () => MetricPlugin> = {
  ttfb: TTFB,
  fcp: FCP,
  lcp: LCP,
  playbackLatency: PlaybackLatency,
  audioDrift: AudioDrift,
  stageUpdateTime: StageUpdateTime,
  blockThroughput: BlockThroughput,
  projectLoadTime: ProjectLoadTime,
};

const DEFAULT_METRICS = ['ttfb', 'fcp', 'lcp'];

interface Args {
  pages: string[];
  runs: number;
  out: string;
  metrics: string[];
}

function parseArgs(argv: string[]): Args {
  const pages: string[] = [];
  let runs = 11;
  let out = 'results.json';
  let metrics: string[] | undefined;
  let configPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pages' && i + 1 < argv.length) {
      pages.push(...argv[++i].split(','));
    } else if (argv[i] === '--runs' && i + 1 < argv.length) {
      runs = parseInt(argv[++i], 10);
    } else if (argv[i] === '--out' && i + 1 < argv.length) {
      out = argv[++i];
    } else if (argv[i] === '--metrics' && i + 1 < argv.length) {
      metrics = argv[++i].split(',');
    } else if (argv[i] === '--config' && i + 1 < argv.length) {
      configPath = argv[++i];
    }
  }

  // Load config file if specified
  if (configPath) {
    const resolved = path.resolve(configPath);
    if (fs.existsSync(resolved)) {
      try {
        const config: ConfigFile = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
        if (config.pages && pages.length === 0) pages.push(...config.pages);
        if (config.runs !== undefined && !argv.includes('--runs')) runs = config.runs;
        if (config.metrics && !metrics) metrics = config.metrics;
      } catch (err) {
        console.error(`Error: could not parse config file: ${resolved}`);
        process.exit(1);
      }
    } else {
      console.error(`Error: config file not found: ${resolved}`);
      process.exit(1);
    }
  }

  if (pages.length === 0) {
    console.error('Error: --pages is required or must be specified in config file');
    process.exit(1);
  }

  return { pages, runs, out, metrics: metrics ?? DEFAULT_METRICS };
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  const resolvedPages = args.pages.map((p) => path.resolve(p));

  const pagesDir = path.dirname(resolvedPages[0]);

  const relativePages = resolvedPages.map((p) => path.relative(pagesDir, p));

  const driver = new BenchmarkDriver({
    pages: relativePages,
    runs: args.runs,
    settleMs: 1500,
    port: 8934,
  });

  const plugins: MetricPlugin[] = args.metrics.map((name) => {
    const Cls = ALL_PLUGINS[name];
    if (!Cls) {
      console.error(`Error: unknown metric "${name}". Available: ${Object.keys(ALL_PLUGINS).join(', ')}`);
      process.exit(1);
    }
    return new Cls();
  });

  const origDir = process.cwd();
  process.chdir(pagesDir);

  let results;
  try {
    results = await driver.run(plugins);
  } finally {
    process.chdir(origDir);
  }

  const outPath = path.resolve(args.out);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nSaved raw results to ${outPath}`);

  console.log('\n=== Median summary ===');
  for (const pageResult of results) {
    const pluginNames = plugins.map((p) => p.name);
    const medians: Record<string, number> = {};
    for (const name of pluginNames) {
      const values = pageResult.runs
        .map((r) => r.metrics[name])
        .filter((v): v is number => v !== null);
      medians[name] = values.length > 0 ? median(values) : 0;
    }
    const line = pluginNames
      .map((name) => `${name}=${medians[name].toFixed(1)}${name === 'blockThroughput' ? '' : 'ms'}`)
      .join('  ');
    console.log(`${pageResult.page}: ${line}`);
  }
}
