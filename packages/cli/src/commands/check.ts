import path from 'path';
import fs from 'fs';
import type { PageResult, BaselineData, BaselinePage, ThresholdLevel, PerfSenseConfig, MetricCheckResult, CheckStatus, Evidence, EvidenceHighlight } from '@perfsense/core';
import { median, classifyRegression } from '@perfsense/statistics';
import type { ClassificationResult } from '@perfsense/statistics';
import { EvidenceCollector } from '@perfsense/driver-playwright';
import { LCP, FCP, TTFB } from '@perfsense/metrics-core';
import { PlaybackLatency, AudioDrift, StageUpdateTime, BlockThroughput, ProjectLoadTime } from '@perfsense/metrics-musicblocks';
import type { MetricPlugin } from '@perfsense/core';

const DEFAULT_THRESHOLDS: Record<string, ThresholdLevel> = {
  TTFB: { warning: 10, fail: 30 },
  FCP: { warning: 5, fail: 10 },
  LCP: { warning: 5, fail: 10 },
};

const ALL_PLUGINS: Record<string, new () => MetricPlugin> = {
  ttfb: TTFB,
  fcp: FCP,
  lcp: LCP,
  playbacklatency: PlaybackLatency,
  audiodrift: AudioDrift,
  stageupdatetime: StageUpdateTime,
  blockthroughput: BlockThroughput,
  projectloadtime: ProjectLoadTime,
};

function getMetricNames(runs: PageResult['runs']): string[] {
  const names = new Set<string>();
  for (const run of runs) {
    for (const key of Object.keys(run.metrics)) {
      names.add(key);
    }
  }
  return Array.from(names);
}

function loadConfig(configPath?: string): PerfSenseConfig | null {
  const searchPaths: string[] = configPath
    ? [path.resolve(configPath)]
    : [path.resolve('perfsense.config.json')];

  for (const sp of searchPaths) {
    if (fs.existsSync(sp)) {
      try {
        return JSON.parse(fs.readFileSync(sp, 'utf-8'));
      } catch {
        console.warn(`Warning: could not parse config file: ${sp}`);
      }
    }
  }
  return null;
}

function getThreshold(metric: string, config: PerfSenseConfig | null): ThresholdLevel {
  if (config?.thresholds?.[metric]) {
    return config.thresholds[metric];
  }
  if (DEFAULT_THRESHOLDS[metric]) {
    return DEFAULT_THRESHOLDS[metric];
  }
  return { warning: 10, fail: 20 };
}

function computeDeltaPercent(baseline: number, current: number): number {
  if (baseline === 0) return current > 0 ? 100 : 0;
  return ((current - baseline) / baseline) * 100;
}

function determineStatus(deltaPercent: number, threshold: ThresholdLevel): CheckStatus {
  if (deltaPercent < 0) return 'PASS';
  if (deltaPercent < threshold.warning) return 'PASS';
  if (deltaPercent < threshold.fail) return 'WARNING';
  return 'REGRESSION';
}

function padEnd(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function mapStatus(s: ClassificationResult['status']): CheckStatus {
  if (s === 'regression') return 'REGRESSION';
  if (s === 'warning') return 'WARNING';
  return 'PASS';
}

interface EnrichedCheckResult extends MetricCheckResult {
  pValue: number | null;
  effectSize: number | null;
  confidenceInterval: [number, number] | null;
  evidence?: Evidence[];
}

function collectCurrentValues(pageResult: PageResult, metric: string): number[] {
  return pageResult.runs
    .map((r) => r.metrics[metric])
    .filter((v): v is number => v !== null);
}

function collectBaselineValues(baselinePage: BaselinePage, metric: string): number[] | null {
  const stats = baselinePage[metric];
  if (!stats) return null;
  if (Array.isArray(stats.values) && stats.values.length > 0) return stats.values;
  return null;
}

function buildPluginsFromMetrics(metricNames: string[]): MetricPlugin[] {
  const plugins: MetricPlugin[] = [];
  for (const name of metricNames) {
    const key = name.toLowerCase();
    const Cls = ALL_PLUGINS[key];
    if (Cls) {
      plugins.push(new Cls());
    }
  }
  return plugins;
}

async function collectEvidence(
  regressedPages: Set<string>,
  currentResults: PageResult[],
  config: PerfSenseConfig | null,
  configPath: string | undefined,
  allResults: EnrichedCheckResult[],
): Promise<void> {
  if (regressedPages.size === 0) return;

  let rawConfig: any = null;
  if (configPath) {
    const resolved = path.resolve(configPath);
    if (fs.existsSync(resolved)) {
      try {
        rawConfig = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
      } catch { /* ignore */ }
    }
  }
  if (!rawConfig) {
    try {
      const defaultCfg = path.resolve('perfsense.config.json');
      if (fs.existsSync(defaultCfg)) {
        rawConfig = JSON.parse(fs.readFileSync(defaultCfg, 'utf-8'));
      }
    } catch { /* ignore */ }
  }
  if (!rawConfig) {
    console.error('  [evidence] No config found; cannot determine pages to re-run. Skipping evidence.');
    return;
  }

  const configPages: string[] = rawConfig.pages || [];
  if (configPages.length === 0) {
    console.error('  [evidence] No pages in config. Skipping evidence.');
    return;
  }

  const configDir = process.cwd();

  const resolvedPagePaths = configPages.map((p: string) => path.resolve(configDir, p));
  const pagesDir = resolvedPagePaths.length > 0 ? path.dirname(resolvedPagePaths[0]) : configDir;
  const relativePages = resolvedPagePaths.map((p: string) => path.relative(pagesDir, p));

  const pagesToEvince = relativePages.filter((p: string) => {
    const basename = path.basename(p);
    return regressedPages.has(basename);
  });

  if (pagesToEvince.length === 0) return;

  const allMetricNames = new Set<string>();
  for (const r of allResults) allMetricNames.add(r.metric);
  const plugins = buildPluginsFromMetrics(Array.from(allMetricNames));

  if (plugins.length === 0) return;

  const collector = new EvidenceCollector(8935, 1500);

  console.error('\n  [evidence] ---');
  let evidenceMap: Record<string, Evidence[]>;
  try {
    evidenceMap = await collector.collect(plugins, pagesDir, pagesToEvince);
  } catch (err: any) {
    console.error(`  [evidence] Collection failed: ${err.message}`);
    return;
  }

  for (const result of allResults) {
    const pageEvidence = evidenceMap[result.page];
    if (pageEvidence && result.status === 'REGRESSION') {
      result.evidence = pageEvidence;
    }
  }
}

export async function run(argv: string[]): Promise<void> {
  let baselineFile = 'baseline.json';
  let currentFile = 'results.json';
  let configPath: string | undefined;
  let useStatistical = false;
  let formatJson = false;
  let noEvidence = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--baseline' && i + 1 < argv.length) {
      baselineFile = argv[++i];
    } else if (argv[i] === '--current' && i + 1 < argv.length) {
      currentFile = argv[++i];
    } else if (argv[i] === '--config' && i + 1 < argv.length) {
      configPath = argv[++i];
    } else if (argv[i] === '--statistical') {
      useStatistical = true;
    } else if (argv[i] === '--format' && i + 1 < argv.length) {
      formatJson = argv[++i] === 'json';
    } else if (argv[i] === '--no-evidence') {
      noEvidence = true;
    }
  }

  const baselinePath = path.resolve(baselineFile);
  if (!fs.existsSync(baselinePath)) {
    console.error(`Error: baseline file not found: ${baselinePath}`);
    process.exit(1);
  }

  const currentPath = path.resolve(currentFile);
  if (!fs.existsSync(currentPath)) {
    console.error(`Error: current results file not found: ${currentPath}`);
    process.exit(1);
  }

  const baseline: BaselineData = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  const current: PageResult[] = JSON.parse(fs.readFileSync(currentPath, 'utf-8'));
  const config = loadConfig(configPath);

  const allResults: EnrichedCheckResult[] = [];
  let hasRegression = false;
  const regressedPages = new Set<string>();

  for (const pageResult of current) {
    const pageName = pageResult.page;
    const baselinePage: BaselinePage | undefined = baseline.pages[pageName];

    if (!baselinePage) {
      process.stderr.write(`Warning: no baseline data for page "${pageName}", skipping\n`);
      continue;
    }

    const metricNames = getMetricNames(pageResult.runs);

    for (const metric of metricNames) {
      const currentValues = collectCurrentValues(pageResult, metric);
      if (currentValues.length === 0) {
        process.stderr.write(`Warning: no valid values for ${pageName}/${metric}, skipping\n`);
        continue;
      }

      const baselineStats = baselinePage[metric];
      if (!baselineStats) {
        process.stderr.write(`Warning: no baseline for ${pageName}/${metric}, skipping\n`);
        continue;
      }

      const currentMedian = median(currentValues);
      const baselineMedian = baselineStats.median;
      const deltaPercent = computeDeltaPercent(baselineMedian, currentMedian);
      const threshold = getThreshold(metric, config);

      let status: CheckStatus;
      let pValue: number | null = null;
      let effectSize: number | null = null;
      let confidenceInterval: [number, number] | null = null;

      if (useStatistical) {
        const baselineValues = collectBaselineValues(baselinePage, metric);
        const hasBaselineValues = baselineValues !== null && baselineValues.length > 0;

        if (hasBaselineValues) {
          const result = classifyRegression(baselineValues, currentValues, threshold);
          status = mapStatus(result.status);
          pValue = result.pValue;
          effectSize = result.effectSize;
          confidenceInterval = result.confidenceInterval;
        } else {
          status = determineStatus(deltaPercent, threshold);
        }
      } else {
        status = determineStatus(deltaPercent, threshold);
      }

      allResults.push({
        page: pageName,
        metric,
        status,
        deltaPercent,
        failThreshold: threshold.fail,
        baselineMedian,
        currentMedian,
        pValue,
        effectSize,
        confidenceInterval,
      });

      if (status === 'REGRESSION') {
        hasRegression = true;
        regressedPages.add(pageName);
      }
    }
  }

  // Evidence collection
  if (hasRegression && !noEvidence) {
    await collectEvidence(regressedPages, current, config, configPath, allResults);

    // Copy evidence to all regression results on same page
    const pageToEvidence: Record<string, Evidence[]> = {};
    for (const r of allResults) {
      if (r.evidence && r.evidence.length > 0) {
        pageToEvidence[r.page] = r.evidence;
      }
    }
    for (const r of allResults) {
      if (!r.evidence && pageToEvidence[r.page] && r.status === 'REGRESSION') {
        r.evidence = pageToEvidence[r.page];
      }
    }
  }

  // Output
  if (formatJson) {
    const jsonOutput = {
      results: allResults.map((r) => ({
        page: r.page,
        metric: r.metric,
        status: r.status,
        deltaPercent: Number(r.deltaPercent.toFixed(1)),
        pValue: r.pValue !== null ? Number(r.pValue.toFixed(4)) : null,
        effectSize: r.effectSize !== null ? Number(r.effectSize.toFixed(2)) : null,
        confidenceInterval: r.confidenceInterval,
        failThreshold: r.failThreshold,
        baselineMedian: Number(r.baselineMedian.toFixed(1)),
        currentMedian: Number(r.currentMedian.toFixed(1)),
        evidence: r.evidence ? r.evidence.map((e) => ({
          type: e.type,
          summary: e.summary,
          highlights: e.highlights,
        })) : undefined,
      })),
      summary: {
        pass: allResults.filter((r) => r.status === 'PASS').length,
        warning: allResults.filter((r) => r.status === 'WARNING').length,
        regression: allResults.filter((r) => r.status === 'REGRESSION').length,
        failed: hasRegression,
      },
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
  } else {
    const printedPages = new Set<string>();
    for (const r of allResults) {
      if (!printedPages.has(r.page)) {
        if (printedPages.size > 0) console.log();
        console.log(`--- ${r.page} ---`);
        printedPages.add(r.page);
      }

      const sign = r.deltaPercent >= 0 ? '+' : '';
      if (r.pValue !== null && r.effectSize !== null && r.confidenceInterval !== null) {
        const ci = r.confidenceInterval;
        const line = `  ${padEnd(r.metric, 8)} ${padEnd(r.status, 10)} ${sign}${r.deltaPercent.toFixed(1)}%  (p=${r.pValue.toFixed(4)}, d=${r.effectSize.toFixed(2)}, CI: [${ci[0].toFixed(1)}, ${ci[1].toFixed(1)}])`;
        console.log(line);
      } else {
        const line = `  ${padEnd(r.metric, 8)} ${padEnd(r.status, 10)} (${sign}${r.deltaPercent.toFixed(1)}%, threshold: ${r.failThreshold}%)`;
        console.log(line);
      }

      // Display evidence
      if (r.evidence && r.evidence.length > 0) {
        for (const ev of r.evidence) {
          const icon = ev.type === 'trace' ? 'Trace' : ev.type === 'network' ? 'Network' : 'Git diff';
          console.log(`  ${padEnd('', 12)}${icon}: ${ev.summary}`);
          for (const hl of ev.highlights) {
            const mark = hl.severity === 'critical' ? '!' : hl.severity === 'warning' ? '~' : ' ';
            console.log(`  ${padEnd('', 16)}${mark} ${hl.label}: ${hl.value}`);
          }
        }
      }
    }

    if (hasRegression) {
      console.log('\nFAILED: One or more metrics exceeded the fail threshold.');
      process.exit(1);
    }
  }
}
