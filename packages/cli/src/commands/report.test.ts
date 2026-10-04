import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type {
  BaselineData,
  BaselineMetricStatsV2,
  PageResult,
} from "@perfsense/core";
import { run } from "./report";
import { computeEnvironmentFingerprint } from "./env";

function stats(values: number[]): BaselineMetricStatsV2 {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1),
  );
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p10: sorted[0],
    p90: sorted[sorted.length - 1],
    values,
    mean,
    sd,
    mad: 0,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p25: sorted[1],
    p75: sorted[3],
    cv: mean === 0 ? Infinity : sd / Math.abs(mean),
    n: values.length,
    invalid: 0,
    stability: { tier: "stable", flagged: false },
  };
}

let dir: string;
let originalLog: typeof console.log;
let originalEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "perfsense-harness-"));
  originalLog = console.log;
  originalEnv = process.env.PERFSENSE_REF;
});

afterEach(() => {
  console.log = originalLog;
  if (originalEnv === undefined) delete process.env.PERFSENSE_REF;
  else process.env.PERFSENSE_REF = originalEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Baseline with one fixture whose metric moves hard enough to classify on its own.
 * `withEnv: false` (the default) reproduces a legacy v1 baseline: no environment
 * fingerprint, so nothing about the comparison can be certified.
 */
function writeBaseline(
  harnessRef: string | null,
  opts: { withEnv?: boolean } = {},
): string {
  const file = path.join(dir, "baseline.json");
  const baseline: BaselineData = {
    schema: "perfsense-baseline-v2",
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    runs: 5,
    commitSHA: "abc1234",
    source: "test",
    harness:
      harnessRef === null
        ? {
            ref: null,
            source: "unavailable",
            reason: "PERFSENSE_REF is not set.",
          }
        : { ref: harnessRef, source: "PERFSENSE_REF" },
    pages: {
      "index.html": {
        bootstrapTotal: stats([5300, 5310, 5320, 5330, 5340]),
        initTotal: stats([250, 251, 252, 253, 254]),
        heapAfterBoot: stats([47.2e6, 47.3e6, 47.4e6, 47.5e6, 47.6e6]),
      },
    },
  };
  if (opts.withEnv) baseline.env = computeEnvironmentFingerprint();
  fs.writeFileSync(file, JSON.stringify(baseline));
  return file;
}

/** Current results that would post a bootstrapTotal regression on their own merits. */
function writeCurrent(): string {
  const file = path.join(dir, "current.json");
  const values = [7000, 7100, 7200, 7300, 7400];
  const current: PageResult[] = [
    {
      page: "index.html",
      runs: values.map((v, i) => ({
        run: i + 1,
        metrics: { bootstrapTotal: v, initTotal: 400, heapAfterBoot: 48e6 },
      })),
    },
  ];
  fs.writeFileSync(file, JSON.stringify(current));
  return file;
}

async function reportJson(
  baselineFile: string,
  currentFile: string,
): Promise<any> {
  let captured = "";
  console.log = (msg?: unknown) => {
    captured += String(msg ?? "");
  };
  await run([
    "--baseline",
    baselineFile,
    "--current",
    currentFile,
    "--format",
    "json",
  ]);
  return JSON.parse(captured);
}

describe("report harness gate", () => {
  it("posts a regression when both sides ran the same harness", async () => {
    process.env.PERFSENSE_REF = "aaaaaaa";
    const report = await reportJson(writeBaseline("aaaaaaa"), writeCurrent());
    const boot = report.check.results.find(
      (r: any) => r.metric === "bootstrapTotal",
    );
    expect(boot.status).toBe("REGRESSION");
    expect(report.check.summary.failed).toBe(true);
    expect(report.check.baselineMeta.harness.state).toBe("match");
  });

  it("withholds every verdict when the baseline came from another harness", async () => {
    process.env.PERFSENSE_REF = "bbbbbbb";
    const report = await reportJson(writeBaseline("aaaaaaa"), writeCurrent());
    expect(report.check.baselineMeta.harness.state).toBe("mismatch");
    // The same data that posts a regression above must not assert one here.
    const boot = report.check.results.find(
      (r: any) => r.metric === "bootstrapTotal",
    );
    expect(boot.status).toBe("INCONCLUSIVE");
    expect(boot.note).toContain("aaaaaaa");
    expect(boot.note).toContain("bbbbbbb");
    expect(report.check.summary.failed).toBe(false);
    expect(report.check.summary.regression).toBe(0);
    expect(report.check.summary.warning).toBe(0);
  });

  it("still shows the delta it refuses to interpret", async () => {
    process.env.PERFSENSE_REF = "bbbbbbb";
    const report = await reportJson(writeBaseline("aaaaaaa"), writeCurrent());
    const boot = report.check.results.find(
      (r: any) => r.metric === "bootstrapTotal",
    );
    expect(boot.deltaPercent).toBeGreaterThan(30);
    expect(boot.baselineMedian).toBe(5320);
    expect(boot.currentMedian).toBe(7200);
  });

  it("does not ask the AI to explain a withheld verdict", async () => {
    process.env.PERFSENSE_REF = "bbbbbbb";
    let captured = "";
    console.log = (msg?: unknown) => {
      captured += String(msg ?? "");
    };
    // No --ai-provider is passed, so aiNeeded can never be true here; the point
    // is that a mismatch produces no regression entry to explain.
    await run([
      "--baseline",
      writeBaseline("aaaaaaa"),
      "--current",
      writeCurrent(),
      "--format",
      "json",
    ]);
    const report = JSON.parse(captured);
    expect(report.aiNeeded).toBe(false);
    expect(report.correlation).toBeUndefined();
  });

  it("issues verdicts but marks them uncertifiable when the baseline recorded no harness", async () => {
    process.env.PERFSENSE_REF = "bbbbbbb";
    const report = await reportJson(
      writeBaseline(null, { withEnv: true }),
      writeCurrent(),
    );
    expect(report.check.baselineMeta.harness.state).toBe("unknown");
    const boot = report.check.results.find(
      (r: any) => r.metric === "bootstrapTotal",
    );
    // The regression itself is unchanged — classification is untouched — but it
    // is no longer presented as a finding, because a comparison against a
    // baseline with no recorded harness cannot be shown to measure the same thing.
    expect(boot.status).toBe("REGRESSION");
    expect(boot.comparisonCertified).toBe(false);
    expect(report.check.baselineMeta.comparisonCertified).toBe(false);
    expect(report.check.baselineMeta.uncertifiableReasons.join(" ")).toContain(
      "no PerfSense revision",
    );
    expect(report.prComment).toContain(
      "Baseline records no PerfSense revision",
    );
    expect(report.prComment).toContain("uncertified");
  });

  it("issues verdicts outside the workflow, but marks them uncertifiable", async () => {
    delete process.env.PERFSENSE_REF;
    const report = await reportJson(
      writeBaseline("aaaaaaa", { withEnv: true }),
      writeCurrent(),
    );
    expect(report.check.baselineMeta.harness.state).toBe("unknown");
    const boot = report.check.results.find(
      (r: any) => r.metric === "bootstrapTotal",
    );
    expect(boot.status).toBe("REGRESSION");
    expect(boot.comparisonCertified).toBe(false);
    // The baseline is not the stale side here — this run simply has no
    // provenance to compare against — so the banner stays quiet while the
    // reason is still stated explicitly rather than left implicit.
    expect(report.prComment).not.toContain(
      "Baseline records no PerfSense revision",
    );
    expect(report.check.baselineMeta.uncertifiableReasons.join(" ")).toContain(
      "this run does not record a PerfSense revision",
    );
    expect(report.prComment).toContain("uncertifiable");
    expect(report.prComment).toContain("· uncertified");
  });

  it("renders the mismatch banner in the comment", async () => {
    process.env.PERFSENSE_REF = "bbbbbbb";
    let captured = "";
    console.log = (msg?: unknown) => {
      captured += String(msg ?? "");
    };
    await run([
      "--baseline",
      writeBaseline("aaaaaaa"),
      "--current",
      writeCurrent(),
    ]);
    expect(captured).toContain("different PerfSense revision");
    expect(captured).toContain("every verdict is withheld");
  });
});

describe("baseline certification", () => {
  it("certifies a matching fresh v2 baseline", async () => {
    process.env.PERFSENSE_REF = "aaaaaaa";
    const report = await reportJson(
      writeBaseline("aaaaaaa", { withEnv: true }),
      writeCurrent(),
    );
    const boot = report.check.results.find(
      (r: any) => r.metric === "bootstrapTotal",
    );
    expect(report.check.baselineMeta.harness.state).toBe("match");
    expect(report.check.baselineMeta.hasEnv).toBe(true);
    expect(report.check.baselineMeta.comparisonCertified).toBe(true);
    expect(report.check.baselineMeta.uncertifiableReasons).toEqual([]);
    expect(boot.comparisonCertified).toBe(true);
    // A certified regression still reads as a regression, with no hedging.
    expect(boot.status).toBe("REGRESSION");
    expect(report.prComment).not.toContain("uncertified");
    expect(report.prComment).not.toContain("uncertifiable");
  });

  it("refuses certification when the harness differs", async () => {
    process.env.PERFSENSE_REF = "bbbbbbb";
    const report = await reportJson(
      writeBaseline("aaaaaaa", { withEnv: true }),
      writeCurrent(),
    );
    expect(report.check.baselineMeta.comparisonCertified).toBe(false);
    expect(report.check.baselineMeta.uncertifiableReasons.join(" ")).toContain(
      "bbbbbbb",
    );
  });

  it("refuses certification when the baseline carries no environment fingerprint", async () => {
    process.env.PERFSENSE_REF = "aaaaaaa";
    const report = await reportJson(writeBaseline("aaaaaaa"), writeCurrent());
    expect(report.check.baselineMeta.hasEnv).toBe(false);
    expect(report.check.baselineMeta.comparisonCertified).toBe(false);
    expect(report.check.baselineMeta.uncertifiableReasons.join(" ")).toContain(
      "environment fingerprint",
    );
    expect(report.prComment).toContain("legacy v1");
    expect(report.prComment).toContain("uncertified");
  });

  it("refuses certification for a legacy baseline missing both provenance fields", async () => {
    process.env.PERFSENSE_REF = "aaaaaaa";
    // Strip harness and env entirely: the shape a pre-provenance baseline has.
    const file = writeBaseline("aaaaaaa");
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    delete raw.harness;
    delete raw.env;
    fs.writeFileSync(file, JSON.stringify(raw));
    const report = await reportJson(file, writeCurrent());
    expect(report.check.baselineMeta.comparisonCertified).toBe(false);
    expect(report.check.baselineMeta.uncertifiableReasons).toHaveLength(2);
    expect(report.prComment).toContain(
      "Every verdict in this report is uncertifiable",
    );
  });

  it("does not change classification — only the certification label", async () => {
    // Same harness on both sides, so the hard mismatch withhold never fires; the
    // only difference is the baseline's missing environment fingerprint.
    process.env.PERFSENSE_REF = "aaaaaaa";
    const certified = await reportJson(
      writeBaseline("aaaaaaa", { withEnv: true }),
      writeCurrent(),
    );
    const uncertified = await reportJson(
      writeBaseline("aaaaaaa"),
      writeCurrent(),
    );
    expect(certified.check.baselineMeta.comparisonCertified).toBe(true);
    expect(uncertified.check.baselineMeta.comparisonCertified).toBe(false);
    const pick = (r: any) =>
      Object.fromEntries(
        r.check.results.map((x: any) => [
          x.metric,
          [x.status, x.pValue, x.effectSize, x.deltaPercent],
        ]),
      );
    // Same numbers, same verdicts: the certification gate adds a label, it does
    // not reclassify anything.
    expect(pick(uncertified)).toEqual(pick(certified));
  });
});

describe("report exact fingerprint cells", () => {
  function writeExactBaseline(ref: string): string {
    const file = path.join(dir, "baseline-exact.json");
    const baseline: BaselineData = {
      schema: "perfsense-baseline-v2",
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
      runs: 5,
      commitSHA: "abc1234",
      source: "test",
      harness: { ref, source: "PERFSENSE_REF" },
      pages: {
        "Frere-Jacques.html": {
          transportEventRatio: stats([0.026, 0.026, 0.026, 0.026, 0.026]),
          transportEventCount: stats([268, 268, 268, 268, 268]),
        },
      },
    };
    fs.writeFileSync(file, JSON.stringify(baseline));
    return file;
  }

  function writeExactCurrent(ratio: number, count: number): string {
    const file = path.join(dir, "current-exact.json");
    const current: PageResult[] = [
      {
        page: "Frere-Jacques.html",
        runs: [0, 1, 2, 3, 4].map((i) => ({
          run: i + 1,
          metrics: { transportEventRatio: ratio, transportEventCount: count },
        })),
      },
    ];
    fs.writeFileSync(file, JSON.stringify(current));
    return file;
  }

  it("reports PASS when the fingerprint is bit-identical", async () => {
    process.env.PERFSENSE_REF = "aaaaaaa";
    const report = await reportJson(
      writeExactBaseline("aaaaaaa"),
      writeExactCurrent(0.026, 268),
    );
    const row = report.check.results.find(
      (r: any) => r.metric === "transportEventCount",
    );
    expect(row.status).toBe("PASS");
    expect(report.check.summary.changed).toBe(0);
  });

  it("reports CHANGED (not improvement) when the counter drops to zero", async () => {
    process.env.PERFSENSE_REF = "aaaaaaa";
    const report = await reportJson(
      writeExactBaseline("aaaaaaa"),
      writeExactCurrent(0, 0),
    );
    const count = report.check.results.find(
      (r: any) => r.metric === "transportEventCount",
    );
    expect(count.status).toBe("CHANGED");
    expect(count.baselineMedian).toBe(268);
    expect(count.currentMedian).toBe(0);
    expect(report.check.summary.changed).toBe(2);
    expect(report.check.summary.failed).toBe(true);
  });
});
