import { describe, expect, it } from "vitest";
import type { BaselineData, PageResult } from "@perfsense/core";
import {
  BENCHMARK_MATRIX,
  getFixtureContract,
  isMetricRequired,
  isMetricExact,
  isMetricWarnOnly,
  isMetricApproved,
  getFingerprintExplanation,
  FINGERPRINT_EXPLANATIONS,
} from "@perfsense/benchmark-matrix";
import { findRequiredFailures } from "./requiredMetrics";

/**
 * Required fingerprint cells are the ones that prove a merged optimization was
 * actually measured. These tests pin the contract decisions taken in 2026-10:
 * which cells are required, which two export cells came back as warn-only, and
 * the static explanation table the report reads when a fingerprint moves.
 */

function result(page: string, metrics: Record<string, number | null>): PageResult {
  return { page, runs: [{ run: 1, metrics }] };
}

function baselineCell(values: number[]): BaselineData["pages"][string][string] {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p10: sorted[0],
    p90: sorted[sorted.length - 1],
    mad: 0,
    cv: 0,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p25: sorted[Math.floor(sorted.length * 0.25)],
    p75: sorted[Math.floor(sorted.length * 0.75)],
    stability: "stable",
    values,
  } as unknown as BaselineData["pages"][string][string];
}

describe("required fingerprint contract", () => {
  it("does NOT require musical-tree synthsRetained (baseline 1 = cleanup incomplete)", () => {
    // Still approved and still exact: a change either way must be reported.
    expect(isMetricApproved("musical-tree.html", "synthsRetained")).toBe(true);
    expect(isMetricExact("musical-tree.html", "synthsRetained")).toBe(true);
    // But it is not a required cell: its baseline is already the unhealthy
    // reading, so reverting _cleanupAfterCompletion would leave it at 1 and
    // the tripwire could not see it. Frere-Jacques is the #7832 guard.
    expect(isMetricRequired("musical-tree.html", "synthsRetained")).toBe(false);
    const contract = getFixtureContract("musical-tree.html");
    expect(contract?.requiredMetrics).toEqual([
      "canvasInkCoverage",
      "canvasInkDrift",
    ]);
    // Frere's copy is the one that must stay required.
    expect(isMetricRequired("Frere-Jacques.html", "synthsRetained")).toBe(false);
  });

  it("keeps Frere's transport fingerprints required", () => {
    expect(isMetricRequired("Frere-Jacques.html", "transportEventRatio")).toBe(true);
    expect(isMetricRequired("Frere-Jacques.html", "transportEventCount")).toBe(true);
  });

  it("keeps crabcanon's four render counters required", () => {
    for (const metric of [
      "cacheRebuildCount",
      "cacheSkippedCount",
      "viewportCulledBlocks",
      "viewportCulledFraction",
    ]) {
      expect(isMetricRequired("crabcanon-plot.html", metric)).toBe(true);
      expect(isMetricExact("crabcanon-plot.html", metric)).toBe(true);
    }
  });

  it("has a required cell for six of the seven PRs, and records why #7832 has none", () => {
    const required = new Set<string>();
    for (const contract of BENCHMARK_MATRIX) {
      for (const metric of contract.requiredMetrics ?? []) {
        const why = getFingerprintExplanation(metric);
        if (why) required.add(String(why.pr));
      }
    }
    for (const pr of [7703, 7738, 7815, 7848, 7923, 7970]) {
      expect(required.has(String(pr))).toBe(true);
    }
    // KNOWN GAP, pinned deliberately rather than asserted away.
    //
    // #7832 has no required cell on any fixture. musical-tree's synthsRetained
    // was demoted (its baseline is 1 = cleanup did not run there, so reverting
    // the PR would leave the cell unchanged and undetectable), and Frere's
    // synthsRetained is exact but NOT required.
    //
    // The consequence is that #7832 is currently guarded only by exact cells:
    // a revert of _cleanupAfterCompletion moves Frere's synthsRetained from 0,
    // so the report WILL show CHANGED, but nothing fails the run for it. This
    // assertion exists so that promoting Frere's synthsRetained to required
    // (or adding another #7832 witness) is a deliberate, visible change.
    expect(required.has("7832")).toBe(false);
    expect(isMetricRequired("Frere-Jacques.html", "synthsRetained")).toBe(false);
    expect(isMetricExact("Frere-Jacques.html", "synthsRetained")).toBe(true);
  });
});

describe("restored Rainbow export cells", () => {
  it("approves both export metrics on Rainbow as warn-only, not required", () => {
    for (const metric of ["exportMIDITime", "saveAsLilypondTime"]) {
      expect(isMetricApproved("RainbowConnection.html", metric)).toBe(true);
      expect(isMetricWarnOnly("RainbowConnection.html", metric)).toBe(true);
      // Not required: maxDepth is #7970's deterministic witness; these two are
      // defence-in-depth timing cells.
      expect(isMetricRequired("RainbowConnection.html", metric)).toBe(false);
      // Timing cells, so never exact.
      expect(isMetricExact("RainbowConnection.html", metric)).toBe(false);
    }
  });

  it("keeps Rainbow's exact fingerprints required and exact", () => {
    for (const metric of ["refreshCanvasCallCount", "maxDepth"]) {
      expect(isMetricRequired("RainbowConnection.html", metric)).toBe(true);
      expect(isMetricExact("RainbowConnection.html", metric)).toBe(true);
      expect(isMetricWarnOnly("RainbowConnection.html", metric)).toBe(false);
    }
  });
});

describe("static fingerprint explanation layer", () => {
  it("maps every fingerprint cell to a PR, path, and meaning", () => {
    const entries = Object.entries(FINGERPRINT_EXPLANATIONS);
    expect(entries.length).toBeGreaterThanOrEqual(11);
    for (const [metric, why] of entries) {
      expect(typeof why.pr).toBe("number");
      expect(why.optimization.length).toBeGreaterThan(10);
      expect(why.locations).toMatch(/\.(js|ts)/);
      expect(why.meaning.length).toBeGreaterThan(20);
      // Every explained cell must be an exact cell somewhere in the contract,
      // otherwise the report could explain a non-fingerprint.
      const explained = BENCHMARK_MATRIX.some((c) =>
        (c.exactMetrics ?? []).includes(metric),
      );
      expect(explained).toBe(true);
    }
  });

  it("covers all seven PRs and looks up case-insensitively", () => {
    const prs = new Set(
      Object.values(FINGERPRINT_EXPLANATIONS).map((w) => w.pr),
    );
    expect([...prs].sort((a, b) => a - b)).toEqual([
      7703, 7738, 7815, 7832, 7848, 7923, 7970,
    ]);
    expect(getFingerprintExplanation("CACHESKIPPEDCOUNT")?.pr).toBe(7815);
    expect(getFingerprintExplanation("nopeNotAMetric")).toBeUndefined();
  });

  it("names the real code path for each PR", () => {
    expect(getFingerprintExplanation("transportEventCount")?.locations).toContain(
      "js/logo.js",
    );
    expect(getFingerprintExplanation("viewportCulledBlocks")?.locations).toContain(
      "js/blocks.js",
    );
    expect(getFingerprintExplanation("cacheRebuildCount")?.locations).toContain(
      "js/block.js",
    );
    expect(getFingerprintExplanation("synthsRetained")?.locations).toContain(
      "_cleanupAfterCompletion",
    );
    expect(getFingerprintExplanation("canvasInkCoverage")?.pr).toBe(7848);
    expect(getFingerprintExplanation("refreshCanvasCallCount")?.locations).toContain(
      "js/activity.js",
    );
    expect(getFingerprintExplanation("maxDepth")?.pr).toBe(7970);
  });
});

describe("required-cell presence checking", () => {
  it("treats a cell with no finite numeric sample as absent", () => {
    // The predicate the save and validate gates share: a cell exists only if
    // its values array holds at least one finite number.
    const hasValue = (cell: unknown): boolean =>
      cell !== undefined &&
      cell !== null &&
      Array.isArray((cell as { values?: unknown }).values) &&
      (cell as { values: unknown[] }).values.some(
        (v) => typeof v === "number" && Number.isFinite(v),
      );

    expect(hasValue(baselineCell([1, 2, 3]))).toBe(true);
    // Zero is a real sample, not absence: refreshCanvasCallCount's healthy
    // value is exactly this.
    expect(hasValue(baselineCell([0, 0, 0]))).toBe(true);
    expect(hasValue(undefined)).toBe(false);
    expect(hasValue(null)).toBe(false);
    expect(hasValue({})).toBe(false);
    expect(hasValue({ values: [] })).toBe(false);
    expect(hasValue({ values: [null, null] })).toBe(false);
  });

  it("fails the real gate on a capture missing a required cell", () => {
    // This is the actual gate `baseline save` calls, not a reimplementation of
    // it: the two crabcanon counters were required, approved and collected, yet
    // absent from the v2 baseline, and nothing complained.
    const failures = findRequiredFailures(
      [
        result("crabcanon-plot.html", {
          cacheSkippedCount: 656,
          viewportCulledFraction: 0.855,
          // cacheRebuildCount and viewportCulledBlocks absent entirely.
        }),
      ],
      ["crabcanon-plot.html"],
    );
    expect(failures.map((f) => `${f.fixture}/${f.metric}`)).toEqual([
      "crabcanon-plot.html/cacheRebuildCount",
      "crabcanon-plot.html/viewportCulledBlocks",
    ]);
    // Every failure must carry a reason a human can act on.
    for (const failure of failures) {
      expect(failure.reason.length).toBeGreaterThan(10);
    }
  });

  it("passes the real gate on a complete capture", () => {
    expect(
      findRequiredFailures(
        [
          result("crabcanon-plot.html", {
            cacheRebuildCount: 0,
            cacheSkippedCount: 656,
            viewportCulledBlocks: 796,
            viewportCulledFraction: 0.855,
            transportEventRatio: 0.0264,
          }),
        ],
        ["crabcanon-plot.html"],
      ),
    ).toEqual([]);
  });

  it("does not demand required cells of fixtures the capture omitted", () => {
    // A deliberate single-fixture capture must not be failed for the other five
    // fixtures, which is why the gate is scoped to the captured pages.
    expect(
      findRequiredFailures(
        [
          result("Frere-Jacques.html", {
            transportEventRatio: 0.0253,
            transportEventCount: 268,
          }),
        ],
        ["Frere-Jacques.html"],
      ),
    ).toEqual([]);
  });

  it("treats an all-null collector as missing, not as zero", () => {
    // The distinction that let two cells vanish: a collector that reads null
    // looks like "no data", not "the healthy value".
    const failures = findRequiredFailures(
      [
        result("RainbowConnection.html", {
          refreshCanvasCallCount: null,
          maxDepth: null,
        }),
      ],
      ["RainbowConnection.html"],
    );
    expect(failures.map((f) => `${f.fixture}/${f.metric}`)).toEqual([
      "RainbowConnection.html/refreshCanvasCallCount",
      "RainbowConnection.html/maxDepth",
    ]);
  });
});
