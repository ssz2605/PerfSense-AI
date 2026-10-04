import path from "path";
import fs from "fs";
import type {
  PageResult,
  BaselineData,
  BaselinePage,
  PerfSenseConfig,
  CheckStatus,
  Evidence,
  ThresholdLevel,
  ContractSummary,
} from "@perfsense/core";
import {
  median,
  classifyChange,
  classifyExact,
  type ChangeClassification,
} from "@perfsense/statistics";
import {
  correlate,
  focusCorrelation,
  type CorrelationResult,
  type RegressionEntry,
  type CorrelationInput,
} from "@perfsense/correlation-engine";
import {
  isKnownFixture,
  isMetricApproved,
  isMetricWarnOnly,
  isMetricExact,
  getExactTolerance,
  isMetricRequired,
} from "@perfsense/benchmark-matrix";
import {
  generatePRComment,
  type CheckResult,
  type CheckResultEntry,
  type PRReportOptions,
} from "@perfsense/reporter-github";
import { buildContract } from "./contract";
import {
  computeEnvironmentFingerprint,
  baselineEnvironment,
  environmentsMatch,
  baselineAgeDays,
  currentHarnessRef,
  harnessComparability,
} from "./env";

const DEFAULT_THRESHOLDS: Record<string, ThresholdLevel> = {
  TTFB: { warning: 10, fail: 30 },
  FCP: { warning: 5, fail: 10 },
  LCP: { warning: 5, fail: 10 },
};

export function loadConfig(configPath?: string): PerfSenseConfig | null {
  const searchPaths: string[] = configPath
    ? [path.resolve(configPath)]
    : [path.resolve("perfsense.config.json")];
  for (const sp of searchPaths) {
    if (fs.existsSync(sp)) {
      try {
        return JSON.parse(fs.readFileSync(sp, "utf-8"));
      } catch {
        console.warn(`Warning: could not parse config file: ${sp}`);
      }
    }
  }
  return null;
}

function getThreshold(
  metric: string,
  config: PerfSenseConfig | null,
): ThresholdLevel {
  if (config?.thresholds?.[metric]) return config.thresholds[metric];
  if (DEFAULT_THRESHOLDS[metric]) return DEFAULT_THRESHOLDS[metric];
  return { warning: 10, fail: 25 };
}

function computeDeltaPercent(baseline: number, current: number): number {
  if (baseline === 0) return current > 0 ? 100 : 0;
  return ((current - baseline) / baseline) * 100;
}

function mapStatus(s: ChangeClassification["status"]): CheckStatus {
  switch (s) {
    case "regression":
      return "REGRESSION";
    case "warning":
      return "WARNING";
    case "improvement":
      return "IMPROVEMENT";
    case "likely-noise":
      return "LIKELY_NOISE";
    case "inconclusive":
      return "INCONCLUSIVE";
    default:
      return "PASS";
  }
}

function collectCurrentValues(
  pageResult: PageResult,
  metric: string,
): number[] {
  return pageResult.runs
    .map((r) => r.metrics[metric])
    .filter((v): v is number => typeof v === "number");
}

function collectBaselineValues(
  baselinePage: BaselinePage,
  metric: string,
): number[] | null {
  const stats = baselinePage[metric];
  if (!stats) return null;
  if (Array.isArray(stats.values) && stats.values.length > 0)
    return stats.values;
  return null;
}

function getMetricNames(runs: PageResult["runs"]): string[] {
  const names = new Set<string>();
  for (const run of runs) {
    for (const key of Object.keys(run.metrics)) names.add(key);
  }
  return Array.from(names);
}

export async function run(argv: string[]): Promise<void> {
  let baselineFile = "baseline.json";
  let currentFile = "results.json";
  let configPath: string | undefined;
  let repoDir: string | undefined;
  let sourceMapDir: string | undefined;
  let aiProvider: string | undefined;
  let aiModel: string | undefined;
  let apiKey: string | undefined;
  let formatJson = false;
  let maxFreshDays = 30;
  const reportOptions: PRReportOptions = {};

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--baseline" && i + 1 < argv.length)
      baselineFile = argv[++i];
    else if (argv[i] === "--current" && i + 1 < argv.length)
      currentFile = argv[++i];
    else if (argv[i] === "--config" && i + 1 < argv.length)
      configPath = argv[++i];
    else if (argv[i] === "--repository" && i + 1 < argv.length)
      repoDir = argv[++i];
    else if (argv[i] === "--source-maps" && i + 1 < argv.length)
      sourceMapDir = argv[++i];
    else if (argv[i] === "--ai-provider" && i + 1 < argv.length)
      aiProvider = argv[++i];
    else if (argv[i] === "--ai-model" && i + 1 < argv.length)
      aiModel = argv[++i];
    else if (argv[i] === "--api-key" && i + 1 < argv.length) apiKey = argv[++i];
    else if (argv[i] === "--format" && i + 1 < argv.length)
      formatJson = argv[++i] === "json";
    else if (argv[i] === "--max-fresh-days" && i + 1 < argv.length)
      maxFreshDays = parseInt(argv[++i], 10) || 30;
    else if (argv[i] === "--pr" && i + 1 < argv.length)
      reportOptions.pr = argv[++i];
    else if (argv[i] === "--head" && i + 1 < argv.length)
      reportOptions.head = argv[++i];
    else if (argv[i] === "--baseline-ref" && i + 1 < argv.length)
      reportOptions.baselineRef = argv[++i];
    else if (argv[i] === "--matrix" && i + 1 < argv.length)
      reportOptions.matrix = argv[++i];
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

  const baseline: BaselineData = JSON.parse(
    fs.readFileSync(baselinePath, "utf-8"),
  );
  const current: PageResult[] = JSON.parse(
    fs.readFileSync(currentPath, "utf-8"),
  );
  const config = loadConfig(configPath);

  // ── Baseline trust gates (freshness + environment) ───────────────────
  // A stale or foreign baseline never demotes a regression (regressions are
  // always worth seeing); it only blocks IMPROVEMENT-certification and is
  // reported as a caveat on regression blocks.
  const currentEnv = computeEnvironmentFingerprint();
  const baselineEnv = baselineEnvironment(baseline);
  const envMatched = baselineEnv
    ? environmentsMatch(baselineEnv, currentEnv)
    : null;
  const ageDays = baselineAgeDays(baseline);
  const baselineStale = ageDays !== null && ageDays > maxFreshDays;

  // ── Harness gate ──────────────────────────────────────────────────────
  // Unlike the freshness and environment gates, a harness mismatch cannot be
  // caveated: two PerfSense revisions can collect different metric sets and
  // time the same metric differently, so a delta between them measures the
  // measuring code, not the code under test. Every comparison is therefore
  // withheld rather than reported with a warning attached.
  const baselineHarnessRef = baseline.harness?.ref ?? null;
  const runHarnessRef = currentHarnessRef();
  const harnessState = harnessComparability(baseline, runHarnessRef);
  const harnessMismatch = harnessState === "mismatch";
  const harnessNote = harnessMismatch
    ? `baseline was captured with PerfSense ${baselineHarnessRef}, this run used ${runHarnessRef}; ` +
      "the two sides measure differently, so no verdict is issued"
    : null;

  // ── Certification gate ────────────────────────────────────────────────
  // `mismatch` is withheld outright above. The remaining uncertifiable case is
  // `unknown`: a baseline that records no harness revision, or no environment
  // fingerprint, cannot be shown to have measured the same thing this run did.
  // That difference is unfalsifiable from the numbers, so the delta is still
  // reported — it is a real measurement — but every verdict is labelled
  // uncertifiable rather than presented as a finding about this change.
  const uncertifiableReasons: string[] = [];
  if (harnessState === "mismatch") {
    uncertifiableReasons.push(
      `baseline used PerfSense ${baselineHarnessRef}, this run used ${runHarnessRef}`,
    );
  } else if (harnessState === "unknown") {
    uncertifiableReasons.push(
      baselineHarnessRef
        ? "this run does not record a PerfSense revision, so it cannot be shown to match the baseline"
        : "the baseline records no PerfSense revision",
    );
  }
  if (baselineEnv === null) {
    uncertifiableReasons.push(
      "the baseline has no environment fingerprint (legacy v1 schema)",
    );
  }
  const comparisonCertified = uncertifiableReasons.length === 0;

  const allResults: CheckResultEntry[] = [];
  let hasRegression = false;
  let hasWarning = false;

  for (const pageResult of current) {
    const pageName = pageResult.page;
    const baselinePage: BaselinePage | undefined = baseline.pages[pageName];
    if (!isKnownFixture(pageName)) {
      process.stderr.write(
        `Warning: page "${pageName}" not in Benchmark Matrix, skipping\n`,
      );
      continue;
    }
    if (!baselinePage) {
      process.stderr.write(
        `Warning: no baseline data for page "${pageName}", skipping\n`,
      );
      continue;
    }
    const metricNames = getMetricNames(pageResult.runs);
    for (const metric of metricNames) {
      if (!isMetricApproved(pageName, metric)) {
        process.stderr.write(
          `Warning: ${pageName}/${metric} not approved by Benchmark Matrix, skipping\n`,
        );
        continue;
      }
      const currentValues = collectCurrentValues(pageResult, metric);
      const baselineStats = baselinePage[metric];
      const threshold = getThreshold(metric, config);
      const effectiveMaxStatus: "pass" | "warning" | undefined =
        isMetricWarnOnly(pageName, metric) ? "warning" : threshold.maxStatus;

      // Missing baseline: keep the metric visible instead of silently dropping it.
      if (!baselineStats) {
        const currentMedian =
          currentValues.length > 0 ? median(currentValues) : null;
        allResults.push({
          page: pageName,
          metric,
          status: "NO_BASELINE",
          deltaPercent: null,
          absDelta: null,
          baselineMedian: null,
          currentMedian,
          failThreshold: threshold.fail,
          pValue: null,
          effectSize: null,
          effectZ: null,
          confidenceInterval: null,
          baselineCV: null,
          stabilityTier: null,
          envMatched,
          baselineAgeDays: ageDays,
          note: "no baseline captured for this metric",
        });
        continue;
      }
      if (currentValues.length === 0) {
        process.stderr.write(
          `Warning: no valid values for ${pageName}/${metric}, skipping\n`,
        );
        continue;
      }

      const baselineValues = collectBaselineValues(baselinePage, metric);
      const currentMedian = median(currentValues);
      const baselineMedian = baselineStats.median;
      const deltaPercent = computeDeltaPercent(baselineMedian, currentMedian);
      // v2 baselines carry an explicit CV; legacy v1 baselines leave it
      // undefined so the classifier derives it from the sample values.
      const storedCv = (baselineStats as { cv?: unknown }).cv;
      const storedBaselineCv =
        typeof storedCv === "number" && isFinite(storedCv)
          ? storedCv
          : undefined;

      let entry: CheckResultEntry;
      // Fingerprint cells: a signed-delta percentage says nothing about
      // whether the optimized path is still wired, and for a counter that
      // must not fall, a drop masquerades as an improvement. Compare for
      // equality instead — a deviation in EITHER direction is CHANGED.
      const exactCell = isMetricExact(pageName, metric);
      if (!harnessMismatch && exactCell) {
        const tolerance = getExactTolerance(pageName, metric);
        const reference =
          baselineValues && baselineValues.length > 0
            ? baselineValues
            : [baselineMedian];
        const cls = classifyExact(reference, currentValues, tolerance);
        entry = {
          page: pageName,
          metric,
          status: cls.changed ? "CHANGED" : "PASS",
          deltaPercent,
          absDelta: cls.absDelta,
          baselineMedian,
          currentMedian,
          failThreshold: threshold.fail,
          pValue: null,
          effectSize: null,
          effectZ: null,
          confidenceInterval: null,
          baselineCV:
            typeof storedBaselineCv === "number" ? storedBaselineCv : null,
          stabilityTier: null,
          envMatched,
          baselineAgeDays: ageDays,
          note: cls.changed
            ? `exact check: baseline ${baselineMedian} vs current ${currentMedian} ` +
              `(Δ ${cls.absDelta >= 0 ? "+" : ""}${cls.absDelta}, tolerance ${tolerance}) — ` +
              "fingerprint moved, the optimized code path likely changed"
            : null,
        };
        allResults.push(entry);
        if (entry.status === "CHANGED") hasRegression = true;
        continue;
      }

      if (harnessMismatch) {
        // Withhold the verdict entirely. The delta is still computed and shown
        // so the number is visible, but nothing is asserted about it.
        entry = {
          page: pageName,
          metric,
          status: "INCONCLUSIVE",
          deltaPercent,
          absDelta: currentMedian - baselineMedian,
          baselineMedian,
          currentMedian,
          failThreshold: threshold.fail,
          pValue: null,
          effectSize: null,
          effectZ: null,
          confidenceInterval: null,
          baselineCV:
            typeof storedBaselineCv === "number" ? storedBaselineCv : null,
          stabilityTier: null,
          envMatched,
          baselineAgeDays: ageDays,
          note: harnessNote,
        };
      } else if (baselineValues && baselineValues.length > 0) {
        const baselineCv = storedBaselineCv;
        const cls = classifyChange(
          baselineValues,
          currentValues,
          { ...threshold, maxStatus: effectiveMaxStatus },
          {
            baselineCV: baselineCv,
            envMatched,
            baselineAgeDays: ageDays,
            maxFreshDays,
          },
        );
        entry = {
          page: pageName,
          metric,
          status: mapStatus(cls.status),
          deltaPercent: cls.deltaPercent,
          absDelta: cls.absDelta,
          baselineMedian,
          currentMedian,
          failThreshold: threshold.fail,
          pValue: cls.pValue,
          effectSize: cls.effectSize,
          effectZ: cls.effectZ,
          confidenceInterval: cls.confidenceInterval,
          baselineCV: cls.baselineCV,
          stabilityTier: cls.stabilityTier,
          envMatched,
          baselineAgeDays: ageDays,
          note: ["likely-noise", "inconclusive"].includes(cls.status)
            ? cls.details
            : null,
        };
      } else {
        // Baseline has stats (median) but no sample values — fall back to the
        // delta-only path, capped like the regression path.
        let raw: CheckStatus;
        if (deltaPercent >= threshold.fail) raw = "REGRESSION";
        else if (deltaPercent >= threshold.warning) raw = "WARNING";
        else raw = "PASS";
        const status =
          effectiveMaxStatus === "warning" && raw === "REGRESSION"
            ? "WARNING"
            : effectiveMaxStatus === "pass" && raw !== "PASS"
              ? "PASS"
              : raw;
        entry = {
          page: pageName,
          metric,
          status,
          deltaPercent,
          absDelta: currentMedian - baselineMedian,
          baselineMedian,
          currentMedian,
          failThreshold: threshold.fail,
          pValue: null,
          effectSize: null,
          effectZ: null,
          confidenceInterval: null,
          baselineCV: null,
          stabilityTier: null,
          envMatched,
          baselineAgeDays: ageDays,
          note: null,
        };
      }

      allResults.push(entry);
      if (entry.status === "REGRESSION") hasRegression = true;
      if (entry.status === "WARNING") hasWarning = true;
    }
  }

  // Every verdict inherits the certification state of the comparison it came
  // from, so a per-metric row can never read as certified when the baseline
  // cannot support the claim.
  for (const r of allResults) r.comparisonCertified = comparisonCertified;

  // ── Coverage contract (missing metrics stay visible) ─────────────────
  const contract: ContractSummary = buildContract(current, baseline);

  // ── Deterministic correlation (regressions only) ─────────────────────
  let correlation: CorrelationResult | undefined;
  let correlationError: string | undefined;
  const regressionEntries: RegressionEntry[] = allResults
    .filter(
      (r) =>
        r.status === "REGRESSION" &&
        r.baselineMedian !== null &&
        r.currentMedian !== null,
    )
    .map((r) => ({
      metric: r.metric,
      baselineMedian: r.baselineMedian as number,
      currentMedian: r.currentMedian as number,
      deltaPercent:
        r.deltaPercent ??
        computeDeltaPercent(
          r.baselineMedian as number,
          r.currentMedian as number,
        ),
      pValue: r.pValue ?? 0.001,
      effectSize: r.effectSize ?? 0.8,
      confidenceInterval: (r.confidenceInterval ?? [
        r.currentMedian! * 0.9,
        r.currentMedian! * 1.1,
      ]) as [number, number],
    }));

  if (regressionEntries.length > 0) {
    try {
      const evidence: Evidence[] = [];
      try {
        const { collectGitDiffEvidence } =
          await import("@perfsense/evidence-git-diff");
        evidence.push(
          collectGitDiffEvidence(regressionEntries[0].metric, repoDir),
        );
      } catch {
        // Evidence collection is best-effort; correlation still runs without it.
      }
      correlation = correlate({
        regression: regressionEntries,
        evidence,
        metricSchemas: {},
        sourceMapDir: sourceMapDir ? path.resolve(sourceMapDir) : undefined,
        repoDir: repoDir ? path.resolve(repoDir) : undefined,
      } as CorrelationInput);
    } catch (err: any) {
      correlationError = err.message;
    }
  }

  // ── AI only as an explanation layer, gated to unexplained regressions ─
  // AI never decides a verdict (classification is fully deterministic). It
  // runs strictly when a regression/warning exists AND the deterministic
  // engine could not assign a cause, filling in one focused explanation per
  // metric. This keeps llama3.1 out of PRs that have nothing to explain.
  const aiNeeded = hasRegression || hasWarning;
  let aiAnalysis: string | undefined;
  let aiPerMetric: Record<string, string> | undefined;

  if (aiNeeded && aiProvider) {
    try {
      const { generateAIAnalysis } = require("@perfsense/ai-provider");
      const gitContext = {
        commit: "HEAD",
        message: "",
        author: "",
        filesChanged: [] as string[],
      };
      if (repoDir) {
        try {
          const { execSync } = require("child_process");
          const log = execSync("git log -1 --format=%H%n%s%n%an HEAD", {
            cwd: repoDir,
            encoding: "utf-8",
          })
            .trim()
            .split("\n");
          gitContext.commit = log[0] || "HEAD";
          gitContext.message = log[1] || "";
          gitContext.author = log[2] || "";
          const files = execSync("git diff --name-only HEAD~1 HEAD", {
            cwd: repoDir,
            encoding: "utf-8",
          }).trim();
          gitContext.filesChanged = files ? files.split("\n") : [];
        } catch {
          /* best-effort */
        }
      }
      const effectiveApiKey =
        apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
      const aiConfig = {
        provider: aiProvider as any,
        apiKey: effectiveApiKey,
        model:
          aiModel || (aiProvider === "ollama" ? "llama3.1:8b" : "gpt-4o-mini"),
      };
      if (effectiveApiKey || aiProvider === "ollama") {
        // Holistic analysis only when there is something to analyze.
        if (hasRegression && correlation) {
          const aiResult = await generateAIAnalysis(
            correlation,
            gitContext,
            aiConfig,
          );
          if (aiResult) aiAnalysis = aiResult.explanation;
        }

        // Per-metric explanations for regressions AND warnings whose cause the
        // deterministic engine could not find. Warnings have no correlation
        // entry, so they get one synthesized from the classified result.
        const perMetric: Record<string, string> = {};
        const explainedMetrics = new Set<string>();
        if (correlation) {
          for (const [metric, mc] of Object.entries(correlation.metrics)) {
            if (mc.likelyCause) explainedMetrics.add(metric.toLowerCase());
          }
          for (const c of correlation.crossMetricCauses) {
            for (const m of c.affectedMetrics)
              explainedMetrics.add(m.toLowerCase());
          }
        }
        for (const entry of allResults) {
          const isUnexplainedRegression =
            entry.status === "REGRESSION" &&
            !explainedMetrics.has(entry.metric.toLowerCase());
          const isUnexplainedWarning = entry.status === "WARNING";
          if (!isUnexplainedRegression && !isUnexplainedWarning) continue;
          if (entry.baselineMedian === null || entry.currentMedian === null)
            continue;
          try {
            // Regressions keep the correlation entry the deterministic engine
            // already built, so the model sees the same ranked evidence and
            // perf-sensitive highlights the engine rejected. Only warnings —
            // which never enter correlate() — fall back to a synthesized view.
            const realCorrelation = correlation
              ? focusCorrelation(correlation, entry.metric)
              : null;
            const focusedCorrelation: CorrelationResult = realCorrelation ?? {
              metrics: {
                [entry.metric]: {
                  regression: {
                    metric: entry.metric,
                    baselineMedian: entry.baselineMedian,
                    currentMedian: entry.currentMedian,
                    deltaPercent:
                      entry.deltaPercent ??
                      computeDeltaPercent(
                        entry.baselineMedian,
                        entry.currentMedian,
                      ),
                    pValue: entry.pValue ?? 0.05,
                    effectSize: entry.effectSize ?? 0.147,
                    confidenceInterval: (entry.confidenceInterval ?? [
                      entry.currentMedian * 0.9,
                      entry.currentMedian * 1.1,
                    ]) as [number, number],
                  },
                  evidence: [],
                  likelyCause: null,
                  filteredEvidence: 0,
                },
              },
              crossMetricCauses: [],
              summary: {
                totalRegressions: 1,
                metricsWithCause: 0,
                metricsInconclusive: 1,
              },
            };
            const focused = await generateAIAnalysis(
              focusedCorrelation,
              gitContext,
              aiConfig,
            );
            if (focused) perMetric[entry.metric] = focused.explanation;
          } catch {
            /* per-metric AI failed silently; the block falls back to "No likely cause." */
          }
        }
        if (Object.keys(perMetric).length > 0) aiPerMetric = perMetric;
      }
    } catch {
      // AI analysis failed silently
    }
  }

  // ── Build check result ───────────────────────────────────────────────
  const summary = {
    pass: allResults.filter((r) => r.status === "PASS").length,
    warning: allResults.filter((r) => r.status === "WARNING").length,
    regression: allResults.filter((r) => r.status === "REGRESSION").length,
    improvement: allResults.filter((r) => r.status === "IMPROVEMENT").length,
    likelyNoise: allResults.filter((r) => r.status === "LIKELY_NOISE").length,
    noBaseline: allResults.filter((r) => r.status === "NO_BASELINE").length,
    inconclusive: allResults.filter((r) => r.status === "INCONCLUSIVE").length,
    changed: allResults.filter((r) => r.status === "CHANGED").length,
    failed: hasRegression,
  };
  const checkResult: CheckResult = {
    results: allResults,
    summary,
    correlation,
    correlationError,
    contract,
    baselineMeta: {
      envMatched,
      ageDays,
      stale: baselineStale,
      hasEnv: baselineEnv !== null,
      comparisonCertified,
      uncertifiableReasons,
      harness: {
        baselineRef: baselineHarnessRef,
        runRef: runHarnessRef,
        state: harnessState,
      },
    },
  };

  // Generate PR comment
  const comment = generatePRComment(checkResult, {
    ...reportOptions,
    aiAnalysis,
    aiPerMetric,
  });

  if (formatJson) {
    const report = {
      check: checkResult,
      correlation,
      aiAnalysis,
      aiPerMetric,
      aiNeeded,
      baseline: {
        envMatched,
        ageDays,
        stale: baselineStale,
        hasEnv: baselineEnv !== null,
        comparisonCertified,
        uncertifiableReasons,
        harness: {
          baselineRef: baselineHarnessRef,
          runRef: runHarnessRef,
          state: harnessState,
        },
      },
      prComment: comment,
    };
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(comment);
  }
}
