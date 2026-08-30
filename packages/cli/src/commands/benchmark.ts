import path from 'path';
import fs from 'fs';
import { BenchmarkDriver, isUrl } from '@perfsense/driver-playwright';
import { CORE_PLUGIN_REGISTRY } from '@perfsense/metrics-core';
import { MUSICBLOCKS_PLUGIN_REGISTRY } from '@perfsense/metrics-musicblocks';
import { median } from '@perfsense/statistics';
import type { MetricPlugin } from '@perfsense/core';

interface ConfigFile {
  pages?: string[];
  runs?: number;
  metrics?: string[];
  scenario?: string;
  scenarios?: Record<string, string[]>;
  fixtures?: Record<string, string>;
  thresholds?: Record<string, { warning: number; fail: number }>;
}

const PLUGIN_REGISTRY: Record<string, new () => MetricPlugin> = {
  ...CORE_PLUGIN_REGISTRY,
  ...MUSICBLOCKS_PLUGIN_REGISTRY
};

const DEFAULT_METRICS = ['ttfb', 'fcp', 'lcp'];

interface Args {
  pages: string[];
  runs: number;
  out: string;
  metrics: string[];
  scenario?: string;
  scenarios?: Record<string, string[]>;
  fixtures?: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const pages: string[] = [];
  let runs = 11;
  let out = 'results.json';
  let metrics: string[] | undefined;
  let configPath: string | undefined;
  let scenario: string | undefined;
  let scenarios: Record<string, string[]> | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pages' && i + 1 < argv.length) {
      pages.push(...argv[++i].split(','));
    } else if (argv[i] === '--runs' && i + 1 < argv.length) {
      runs = parseInt(argv[++i], 10);
    } else if (argv[i] === '--out' && i + 1 < argv.length) {
      out = argv[++i];
    } else if (argv[i] === '--metrics' && i + 1 < argv.length) {
      metrics = argv[++i].split(',');
    } else if (argv[i] === '--scenario' && i + 1 < argv.length) {
      scenario = argv[++i];
    } else if (argv[i] === '--config' && i + 1 < argv.length) {
      configPath = argv[++i];
    }
  }

  const fixtures: Record<string, string> = {};

  // Load config file if specified
  if (configPath) {
    const resolved = path.resolve(configPath);
    if (fs.existsSync(resolved)) {
      try {
        const config: ConfigFile = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
        const configDir = path.dirname(resolved);
        if (config.pages && pages.length === 0) pages.push(...config.pages);
        if (config.runs !== undefined && !argv.includes('--runs')) runs = config.runs;
        if (config.metrics && !metrics) metrics = config.metrics;
        if (config.scenario && !scenario) scenario = config.scenario;
        if (config.scenarios) scenarios = config.scenarios;
        if (config.fixtures) {
          for (const [pageName, rel] of Object.entries(config.fixtures)) {
            fixtures[pageName] = path.isAbsolute(rel) ? rel : path.resolve(configDir, rel);
          }
        }
      } catch (err) {
        console.error('Error: could not parse config file: ' + resolved);
        process.exit(1);
      }
    } else {
      console.error('Error: config file not found: ' + resolved);
      process.exit(1);
    }
  }

  if (pages.length === 0) {
    console.error('Error: --pages is required or must be specified in config file');
    process.exit(1);
  }

  return { pages, runs, out, metrics: metrics ?? DEFAULT_METRICS, scenario, scenarios, fixtures };
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  const resolvedPages = args.pages.map((p) => (isUrl(p) ? p : path.resolve(p)));

  const localPages = resolvedPages.filter((p) => !isUrl(p));
  const pagesDir = localPages.length > 0 ? path.dirname(localPages[0]) : process.cwd();

  const relativePages = resolvedPages.map((p) => (isUrl(p) ? p : path.relative(pagesDir, p)));

  const driver = new BenchmarkDriver({
    pages: relativePages,
    runs: args.runs,
    settleMs: 1500,
    port: 8934,
    scenario: args.scenario,
    scenarios: args.scenarios,
    fixtures: args.fixtures && Object.keys(args.fixtures).length > 0 ? args.fixtures : undefined
  });

  const plugins: MetricPlugin[] = args.metrics.map((name) => {
    const Cls = PLUGIN_REGISTRY[name.toLowerCase()];
    if (!Cls) {
      console.error(`Error: unknown metric "${name}". Available: ${Object.keys(PLUGIN_REGISTRY).join(', ')}`);
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
