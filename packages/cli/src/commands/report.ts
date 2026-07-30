import path from 'path';
import fs from 'fs';
import type { PageResult, BaselineData, BaselinePage, PerfSenseConfig, MetricCheckResult, CheckStatus, Evidence } from '@perfsense/core';
import { median, classifyRegression } from '@perfsense/statistics';
import type { ClassificationResult } from '@perfsense/statistics';
import { correlate, type CorrelationInput, type CorrelationResult } from '@perfsense/correlation-engine';
import { generatePRComment, type CheckResult, type CheckResultEntry } from '@perfsense/reporter-github';

const DEFAULT_THRESHOLDS: Record<string, { warning: number; fail: number }> = {
  TTFB: { warning: 10, fail: 30 },
  FCP: { warning: 5, fail: 10 },
  LCP: { warning: 5, fail: 10 },
};

function loadConfig(configPath?: string): PerfSenseConfig | null {
  const searchPaths: string[] = configPath
    ? [path.resolve(configPath)]
    : [path.resolve('perfsense.config.json')];
  for (const sp of searchPaths) {
    if (fs.existsSync(sp)) {
      try { return JSON.parse(fs.readFileSync(sp, 'utf-8')); }
      catch { console.warn(`Warning: could not parse config file: ${sp}`); }
    }
  }
  return null;
}

function getThreshold(metric: string, config: PerfSenseConfig | null): { warning: number; fail: number } {
  if (config?.thresholds?.[metric]) return config.thresholds[metric];
  if (DEFAULT_THRESHOLDS[metric]) return DEFAULT_THRESHOLDS[metric];
  return { warning: 10, fail: 20 };
}

function computeDeltaPercent(baseline: number, current: number): number {
  if (baseline === 0) return current > 0 ? 100 : 0;
  return ((current - baseline) / baseline) * 100;
}

function mapStatus(s: ClassificationResult['status']): CheckStatus {
  if (s === 'regression') return 'REGRESSION';
  if (s === 'warning') return 'WARNING';
  return 'PASS';
}

function collectCurrentValues(pageResult: PageResult, metric: string): number[] {
  return pageResult.runs.map((r) => r.metrics[metric]).filter((v): v is number => v !== null);
}

function collectBaselineValues(baselinePage: BaselinePage, metric: string): number[] | null {
  const stats = baselinePage[metric];
  if (!stats) return null;
  if (Array.isArray(stats.values) && stats.values.length > 0) return stats.values;
  return null;
}

function getMetricNames(runs: PageResult['runs']): string[] {
  const names = new Set<string>();
  for (const run of runs) {
    for (const key of Object.keys(run.metrics)) names.add(key);
  }
  return Array.from(names);
}

export async function run(argv: string[]): Promise<void> {
  let baselineFile = 'baseline.json';
  let currentFile = 'results.json';
  let configPath: string | undefined;
  let repoDir: string | undefined;
  let sourceMapDir: string | undefined;
  let aiProvider: string | undefined;
  let aiModel: string | undefined;
  let apiKey: string | undefined;
  let formatJson = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--baseline' && i + 1 < argv.length) baselineFile = argv[++i];
    else if (argv[i] === '--current' && i + 1 < argv.length) currentFile = argv[++i];
    else if (argv[i] === '--config' && i + 1 < argv.length) configPath = argv[++i];
    else if (argv[i] === '--repository' && i + 1 < argv.length) repoDir = argv[++i];
    else if (argv[i] === '--source-maps' && i + 1 < argv.length) sourceMapDir = argv[++i];
    else if (argv[i] === '--ai-provider' && i + 1 < argv.length) aiProvider = argv[++i];
    else if (argv[i] === '--ai-model' && i + 1 < argv.length) aiModel = argv[++i];
    else if (argv[i] === '--api-key' && i + 1 < argv.length) apiKey = argv[++i];
    else if (argv[i] === '--format' && i + 1 < argv.length) formatJson = argv[++i] === 'json';
  }

  const baselinePath = path.resolve(baselineFile);
  if (!fs.existsSync(baselinePath)) { console.error(`Error: baseline file not found: ${baselinePath}`); process.exit(1); }
  const currentPath = path.resolve(currentFile);
  if (!fs.existsSync(currentPath)) { console.error(`Error: current results file not found: ${currentPath}`); process.exit(1); }

  const baseline: BaselineData = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  const current: PageResult[] = JSON.parse(fs.readFileSync(currentPath, 'utf-8'));
  const config = loadConfig(configPath);

  const allResults: CheckResultEntry[] = [];
  let hasRegression = false;

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

      const baselineValues = collectBaselineValues(baselinePage, metric);
      let status: CheckStatus;
      let pValue: number | null = null;
      let effectSize: number | null = null;
      let confidenceInterval: [number, number] | null = null;
      if (baselineValues && baselineValues.length > 0) {
        const result = classifyRegression(baselineValues, currentValues, threshold);
        status = mapStatus(result.status);
        pValue = result.pValue;
        effectSize = result.effectSize;
        confidenceInterval = result.confidenceInterval;
      } else {
        if (deltaPercent >= threshold.fail) status = 'REGRESSION';
        else if (deltaPercent >= threshold.warning) status = 'WARNING';
        else status = 'PASS';
      }

      allResults.push({ page: pageName, metric, status, deltaPercent, baselineMedian, currentMedian, failThreshold: threshold.fail });
      if (status === 'REGRESSION') hasRegression = true;
    }
  }

  // Run correlation if there are regressions
  let correlation: CorrelationResult | undefined;
  let correlationError: string | undefined;

  if (hasRegression) {
    try {
      const regressionEntries = allResults
        .filter((r) => r.status === 'REGRESSION')
        .map((r) => ({
          metric: r.metric,
          baselineMedian: r.baselineMedian,
          currentMedian: r.currentMedian,
          deltaPercent: r.deltaPercent,
          pValue: 0.001,
          effectSize: 0.8,
          confidenceInterval: [r.currentMedian * 0.9, r.currentMedian * 1.1] as [number, number],
        }));

      correlation = correlate({
        regression: regressionEntries,
        evidence: [],
        metricSchemas: {},
        sourceMapDir: sourceMapDir ? path.resolve(sourceMapDir) : undefined,
        repoDir: repoDir ? path.resolve(repoDir) : undefined,
      });
    } catch (err: any) {
      correlationError = err.message;
    }
  }

  // Run AI analysis if provider configured
  let aiAnalysis: string | undefined;
  if (hasRegression && correlation && aiProvider) {
    try {
      const { generateAIAnalysis } = require('@perfsense/ai-provider');
      const gitContext = { commit: 'HEAD', message: '', author: '', filesChanged: [] };
      const effectiveApiKey = apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
      if (effectiveApiKey || aiProvider === 'ollama') {
        const aiResult = await generateAIAnalysis(correlation, gitContext, {
          provider: aiProvider as any,
          apiKey: effectiveApiKey,
          model: aiModel || 'gpt-4o-mini',
        });
        if (aiResult) {
          aiAnalysis = aiResult.explanation;
        }
      }
    } catch {
      // AI analysis failed silently
    }
  }

  // Build check result
  const checkResult: CheckResult = {
    results: allResults,
    summary: {
      pass: allResults.filter((r) => r.status === 'PASS').length,
      warning: allResults.filter((r) => r.status === 'WARNING').length,
      regression: allResults.filter((r) => r.status === 'REGRESSION').length,
      failed: hasRegression,
    },
    correlation,
    correlationError,
  };

  // Generate PR comment
  const comment = generatePRComment(checkResult, aiAnalysis);

  if (formatJson) {
    const report = {
      check: checkResult,
      correlation,
      aiAnalysis,
      prComment: comment,
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(comment);
  }
}
