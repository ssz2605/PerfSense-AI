import { describe, it, expect } from "vitest";
import {
  BENCHMARK_MATRIX,
  getFixtureContract,
  getApprovedMetrics,
  isKnownFixture,
  isMetricApproved,
  isMetricUnverified,
  isMetricWarnOnly,
  getExactTolerance,
  formatFixtureName,
  formatMetricValue,
  formatDeltaPercent,
} from "./index";

describe("Benchmark Matrix contract", () => {
  it("uses explicit epsilon only for float fingerprints", () => {
    expect(getExactTolerance("Frere-Jacques.html", "transportEventRatio")).toBe(0.0001);
    expect(getExactTolerance("musical-tree.html", "canvasInkCoverage")).toBe(0.0001);
    expect(getExactTolerance("musical-tree.html", "canvasInkDrift")).toBe(0.000001);
    expect(getExactTolerance("crabcanon-plot.html", "viewportCulledFraction")).toBe(0.0001);
    expect(getExactTolerance("Frere-Jacques.html", "transportEventCount")).toBe(0);
    expect(getExactTolerance("RainbowConnection.html", "maxDepth")).toBe(0);
  });
  it("covers every approved fixture exactly once", () => {
    const fixtures = BENCHMARK_MATRIX.map((c) => c.fixture);
    expect(fixtures).toEqual([
      "index.html",
      "RainbowConnection.html",
      "Frere-Jacques.html",
      "musical-tree.html",
      "ascending-notes-color-spiral.html",
      "crabcanon-plot.html",
    ]);
    expect(new Set(fixtures.map((f) => f.toLowerCase())).size).toBe(
      fixtures.length,
    );
  });

  it("defines the approved metric sets per fixture", () => {
    expect(getApprovedMetrics("index.html")).toEqual([
      "bootstrapTotal",
      "initTotal",
      "heapAfterBoot",
    ]);
    // Rainbow keeps the cells that move when a merged perf PR is reverted
    // (refreshCanvasCallCount for #7923, maxDepth for #7970) plus the load
    // timings. exportMIDITime and saveAsLilypondTime are restored as warn-only
    // defence-in-depth for #7970; the stage/cache counters stay gone.
    expect(getApprovedMetrics("RainbowConnection.html")).toEqual([
      "projectLoadTime",
      "saveTime",
      "exportMIDITime",
      "saveAsLilypondTime",
      "refreshCanvasCallCount",
      "peakHeapDuringExport",
      "maxDepth",
    ]);
    // transportEventRatio and synthsRetained are the two audio-family cells that
    // survive a synthesised clock, because both are counts rather than timings.
    expect(getApprovedMetrics("Frere-Jacques.html")).toEqual([
      "callbackLatencyMean",
      "callbackLatencyMax",
      "voiceOnsetError",
      "transportEventRatio",
      "transportEventCount",
      "synthsRetained",
    ]);
    // The repeatedRun cells are PR #7848's invariants. The heap probes and
    // maxQueueDepth are gone.
    expect(getApprovedMetrics("musical-tree.html")).toEqual([
      "executionTime",
      "canvasInkCoverage",
      "canvasInkDrift",
      "synthsRetained",
    ]);
    expect(getApprovedMetrics("ascending-notes-color-spiral.html")).toEqual([
      "executionTime",
      "blocksExecuted",
    ]);
    // scheduleLagMean/scheduleLagMax were removed: at ~1e-11 ms they are
    // constant on unchanged code. stageUpdateTime/stageUpdateMax were removed
    // next: their per-frame distributions are what fails baseline validate.
    expect(getApprovedMetrics("crabcanon-plot.html")).toEqual([
      "cacheRebuildCount",
      "cacheSkippedCount",
      "viewportCulledBlocks",
      "viewportCulledFraction",
      "transportEventRatio",
    ]);
  });

  it("keeps the cell count per fixture explicit and bounded", () => {
    // Every cell here is a row a reviewer is expected to read. The counts are
    // pinned so an accidental re-add of a retired metric is a test failure
    // rather than a slower report.
    const counts: Record<string, number> = {};
    for (const contract of BENCHMARK_MATRIX) {
      counts[contract.fixture] = contract.metrics.length;
    }
    expect(counts).toEqual({
      "index.html": 3,
      "RainbowConnection.html": 7,
      "Frere-Jacques.html": 6,
      "musical-tree.html": 4,
      "ascending-notes-color-spiral.html": 2,
      "crabcanon-plot.html": 5,
    });
    // 27 cells total: 39 before the 2026-10 cleanup, 25 after it, plus the two
    // Rainbow export timings restored as warn-only for #7970.
    const total = BENCHMARK_MATRIX.reduce(
      (sum, c) => sum + c.metrics.length,
      0,
    );
    expect(total).toBe(27);
    // bootstrapTotal survives: it is the one cell that measures the repo rather
    // than a single PR, and it is the fixture that proves the harness is honest.
    expect(isMetricApproved("index.html", "bootstrapTotal")).toBe(true);
  });

  it("retires the cleanup's metrics everywhere except their real owner", () => {
    // Each of these was removed for being unmeasurable, unexercised or too noisy
    // to gate on. cacheRebuildCount and viewportCulledBlocks stay on
    // crabcanon-plot, which is the fixture those two PRs were measured on: they
    // are its fingerprints, and Rainbow only ever borrowed them.
    // exportMIDITime and saveAsLilypondTime are deliberately NOT listed below: they
    // were restored to Rainbow as warn-only cells for #7970. Every other name in
    // this table is still retired everywhere.
    const retired: Record<string, string[]> = {
      stageUpdateCallCount: [],
      stageUpdateTime: [],
      stageUpdateMax: [],
      cacheRebuildCount: ["crabcanon-plot.html"],
      viewportCulledBlocks: ["crabcanon-plot.html"],
      memoryDelta: [],
      retainedHeap: [],
      retainedHeapSlope: [],
      cumulativeDrift: [],
    };
    for (const [metric, owners] of Object.entries(retired)) {
      const approved = BENCHMARK_MATRIX.filter((c) =>
        isMetricApproved(c.fixture, metric),
      ).map((c) => c.fixture);
      expect(approved).toEqual(owners);
      for (const contract of BENCHMARK_MATRIX) {
        // A metric that is not approved for a fixture is never warn-only for it
        // either, so a retired name cannot survive in a warnOnly list.
        if (owners.includes(contract.fixture)) continue;
        expect(isMetricWarnOnly(contract.fixture, metric)).toBe(false);
      }
    }
  });

  it("keeps the retired interpreter/recursion counters out of the contract", () => {
    // These are still collected, but they cannot serve as regression references:
    // blocksExecuted is bit-identical across runs of unchanged code, and
    // maxQueueDepth swings 21-25 while it stays that way. They must not appear
    // as expected cells, or the report asks for baselines it cannot use.
    for (const fixture of ["Frere-Jacques.html", "crabcanon-plot.html"]) {
      expect(isMetricApproved(fixture, "maxQueueDepth")).toBe(false);
      expect(isMetricApproved(fixture, "executionTime")).toBe(false);
      expect(isMetricApproved(fixture, "blocksExecuted")).toBe(false);
    }
    // maxQueueDepth left musical-tree too, and is now approved nowhere: at a
    // median near 8 its quantization floor (2 units = 25%) is above the 20%
    // limit configured for it, so it could fail on rounding alone.
    for (const fixture of [
      "index.html",
      "RainbowConnection.html",
      "Frere-Jacques.html",
      "musical-tree.html",
      "ascending-notes-color-spiral.html",
      "crabcanon-plot.html",
    ]) {
      expect(isMetricApproved(fixture, "maxQueueDepth")).toBe(false);
    }
    expect(isMetricApproved("Frere-Jacques.html", "scheduleCount")).toBe(false);
    expect(isMetricApproved("musical-tree.html", "maxLogicalDepth")).toBe(
      false,
    );
    expect(
      isMetricApproved("ascending-notes-color-spiral.html", "maxLogicalDepth"),
    ).toBe(false);
    // scheduleLagMean/scheduleLagMax left the crabcanon contract (below
    // resolution), so they are no longer approved there either.
    expect(isMetricApproved("crabcanon-plot.html", "scheduleLagMean")).toBe(
      false,
    );
    expect(isMetricApproved("crabcanon-plot.html", "scheduleLagMax")).toBe(
      false,
    );
  });

  it("rejects metrics that are not part of the matrix for a fixture", () => {
    // Frère Jacques owns interpreter + voice timing, but not load/save/export,
    // not memory (musical-tree's double-run records it) and not recursion
    // depth (the three fixtures that own it do so explicitly).
    expect(isMetricApproved("Frere-Jacques.html", "projectLoadTime")).toBe(
      false,
    );
    expect(isMetricApproved("Frere-Jacques.html", "saveTime")).toBe(false);
    expect(isMetricApproved("Frere-Jacques.html", "maxDepth")).toBe(false);
    expect(isMetricApproved("Frere-Jacques.html", "maxActionDepth")).toBe(
      false,
    );
    expect(isMetricApproved("Frere-Jacques.html", "maxLogicalDepth")).toBe(
      false,
    );
    expect(isMetricApproved("Frere-Jacques.html", "memoryDelta")).toBe(false);
    expect(isMetricApproved("Frere-Jacques.html", "retainedHeap")).toBe(false);
    // Rainbow owns load/save/export only; the memory metrics belong to
    // musical-tree (the only fixture that records them during playback).
    expect(isMetricApproved("RainbowConnection.html", "memoryDelta")).toBe(
      false,
    );
    expect(isMetricApproved("RainbowConnection.html", "retainedHeap")).toBe(
      false,
    );
    // maxActionDepth is not in the approved matrix anywhere.
    expect(isMetricApproved("musical-tree.html", "maxActionDepth")).toBe(false);
    // crabcanon-plot keeps its own lag probes and now also reports interpreter
    // cost, but it does not own voice timing or recursion depth.
    expect(isMetricApproved("crabcanon-plot.html", "callbackLatencyMean")).toBe(
      false,
    );
    expect(isMetricApproved("crabcanon-plot.html", "maxLogicalDepth")).toBe(
      false,
    );
    expect(isMetricApproved("crabcanon-plot.html", "memoryDelta")).toBe(false);
  });

  it("is case-insensitive for fixture and metric names", () => {
    // Still-retired names must stay unapproved in any casing.
    expect(isMetricApproved("rainbowconnection.html", "STAGEUPDATECALLCOUNT")).toBe(
      false,
    );
    expect(isMetricApproved("rainbowconnection.html", "RETAINEDHEAP")).toBe(false);
    // The two restored export cells are approved on Rainbow, so they exercise
    // the true branch of the same lookup. Note the exact spelling: these
    // uppercase probes used to read "EXPORTMITITIME", which lowercases to
    // "exportmititime" and so matched nothing. They passed for the wrong
    // reason; these are genuine case-insensitive lookups.
    expect(isMetricApproved("rainbowconnection.html", "EXPORTMIDITIME")).toBe(true);
    expect(isMetricApproved("rainbowconnection.html", "SAVEASLILYPONDTIME")).toBe(
      true,
    );
    expect(isMetricApproved("CRABCANON-PLOT.HTML", "VIEWPORTCULLEDBLOCKS")).toBe(
      true,
    );
    expect(
      isMetricApproved("rainbowconnection.html", "PEAKHEAPDURINGEXPORT"),
    ).toBe(true);
    expect(getFixtureContract("RAINBOWCONNECTION.HTML")?.displayName).toBe(
      "Rainbow Connection",
    );
  });

  it("exposes maxDepth only for Rainbow's #7970 fast path", () => {
    // maxDepth was removed from the approved matrix everywhere except
    // Rainbow, where it is the #7970 fast-run fingerprint.
    expect(isMetricApproved("musical-tree.html", "maxDepth")).toBe(false);
    expect(
      isMetricApproved("ascending-notes-color-spiral.html", "maxDepth"),
    ).toBe(false);
    expect(isMetricApproved("RainbowConnection.html", "maxDepth")).toBe(true);
    expect(isMetricUnverified("musical-tree.html", "maxDepth")).toBe(false);
    expect(
      isMetricUnverified("ascending-notes-color-spiral.html", "maxDepth"),
    ).toBe(false);
    // No approved cell is silently marked unverified: each one is either an exact
    // fingerprint or carries a real threshold.
    for (const contract of BENCHMARK_MATRIX) {
      for (const metric of contract.metrics) {
        expect(isMetricUnverified(contract.fixture, metric)).toBe(false);
      }
    }
    expect(isMetricUnverified("RainbowConnection.html", "exportMIDITime")).toBe(
      false,
    );
  });

  it("marks the warn-only metrics per fixture", () => {
    expect(isMetricWarnOnly("Frere-Jacques.html", "callbackLatencyMean")).toBe(
      true,
    );
    expect(isMetricWarnOnly("Frere-Jacques.html", "callbackLatencyMax")).toBe(
      true,
    );
    expect(isMetricWarnOnly("Frere-Jacques.html", "cumulativeDrift")).toBe(
      false,
    );
    expect(isMetricWarnOnly("Frere-Jacques.html", "voiceOnsetError")).toBe(
      true,
    );
    // musical-tree has no warn-only cell left: its heap probes were retired and
    // the two surviving timings carry real thresholds.
    expect(isMetricWarnOnly("musical-tree.html", "memoryDelta")).toBe(false);
    expect(isMetricWarnOnly("musical-tree.html", "retainedHeap")).toBe(false);
    expect(isMetricWarnOnly("musical-tree.html", "retainedHeapSlope")).toBe(
      false,
    );
    expect(isMetricWarnOnly("musical-tree.html", "executionTime")).toBe(false);
    // Frère Jacques owns a verified count metric: scheduleCount is analyzed but
    // guarded by the seam tripwire, so it is not capped at warning.
    expect(isMetricWarnOnly("Frere-Jacques.html", "scheduleCount")).toBe(false);
    // The interpreter metrics Frère now owns are real measurements, not probes
    // awaiting characterization, so they are not capped.
    expect(isMetricWarnOnly("Frere-Jacques.html", "executionTime")).toBe(false);
    expect(isMetricWarnOnly("Frere-Jacques.html", "blocksExecuted")).toBe(
      false,
    );
    expect(isMetricWarnOnly("Frere-Jacques.html", "maxQueueDepth")).toBe(false);
    // The exact recursion metric is verified for its fixtures.
    expect(isMetricWarnOnly("musical-tree.html", "maxLogicalDepth")).toBe(
      false,
    );
    expect(
      isMetricWarnOnly("ascending-notes-color-spiral.html", "maxLogicalDepth"),
    ).toBe(false);
    // Rainbow no longer lists the memory metrics: not approved here means not
    // warn-only here either (musical-tree is their only home).
    expect(isMetricWarnOnly("RainbowConnection.html", "memoryDelta")).toBe(
      false,
    );
    expect(isMetricWarnOnly("RainbowConnection.html", "retainedHeap")).toBe(
      false,
    );
    // Verified metrics are not warn-only, and neither is scheduleLag.
    expect(isMetricWarnOnly("index.html", "bootstrapTotal")).toBe(false);
    expect(isMetricWarnOnly("RainbowConnection.html", "projectLoadTime")).toBe(
      false,
    );
    // The crabcanon lag probes were removed from the contract entirely (below
    // timer resolution), so they are neither approved nor warn-only now. Not
    // approved for a fixture means not warn-only for it, same as any other
    // unlisted metric. Its render cells are warn-only while their CI spread is
    // uncharacterized.
    expect(isMetricWarnOnly("crabcanon-plot.html", "scheduleLagMean")).toBe(
      false,
    );
    expect(isMetricWarnOnly("crabcanon-plot.html", "scheduleLagMax")).toBe(
      false,
    );
    expect(isMetricApproved("crabcanon-plot.html", "scheduleLagMean")).toBe(
      false,
    );
    expect(isMetricWarnOnly("crabcanon-plot.html", "stageUpdateTime")).toBe(
      false,
    );
    // The crab canon render/cull cells are exact fingerprints now: a revert
    // of #7738/#7815 must read as CHANGED, not as a capped warning.
    expect(
      isMetricWarnOnly("crabcanon-plot.html", "viewportCulledBlocks"),
    ).toBe(false);
    expect(isMetricWarnOnly("crabcanon-plot.html", "transportEventRatio")).toBe(
      true,
    );
    expect(isMetricWarnOnly("crabcanon-plot.html", "executionTime")).toBe(
      false,
    );
    expect(isMetricWarnOnly("crabcanon-plot.html", "blocksExecuted")).toBe(
      false,
    );
    // A metric listed only in another fixture's set is not simply warn-only:
    // it is not approved at all for this fixture.
    expect(isMetricApproved("index.html", "memoryDelta")).toBe(false);
  });

  it("rejects every metric outside its fixture list (strict contract)", () => {
    // No metric may appear outside its approved list: the full registry of
    // metrics must be rejected for fixtures that do not list them.
    const allMetrics = [
      "bootstrapTotal",
      "initTotal",
      "heapAfterBoot",
      "projectLoadTime",
      "saveTime",
      "exportMIDITime",
      "saveAsLilypondTime",
      "callbackLatencyMean",
      "callbackLatencyMax",
      "cumulativeDrift",
      "voiceOnsetError",
      "maxQueueDepth",
      "executionTime",
      "blocksExecuted",
      "maxLogicalDepth",
      "memoryDelta",
      "retainedHeap",
      "scheduleLagMean",
      "scheduleLagMax",
      "scheduleCount",
    ];
    for (const contract of BENCHMARK_MATRIX) {
      for (const metric of allMetrics) {
        const approved = contract.metrics.some(
          (m) => m.toLowerCase() === metric.toLowerCase(),
        );
        expect(isMetricApproved(contract.fixture, metric)).toBe(approved);
      }
    }
    // maxActionDepth is not part of the contract anywhere.
    expect(isMetricApproved("musical-tree.html", "maxActionDepth")).toBe(false);
  });

  it("formats display names and values professionally", () => {
    expect(formatFixtureName("RainbowConnection.html")).toBe(
      "Rainbow Connection",
    );
    expect(formatFixtureName("Frere-Jacques.html")).toBe("Frère Jacques");
    expect(formatFixtureName("unknown.html")).toBe("unknown.html");
    expect(formatMetricValue(5370.46, "bootstrapTotal")).toBe("5370.5 ms");
    // Heap is captured in bytes and presented in MB.
    expect(formatMetricValue(47400000, "heapAfterBoot")).toBe("47.4 MB");
    expect(formatMetricValue(0, "memoryDelta")).toBe("0 B");
    expect(formatMetricValue(1, "maxQueueDepth")).toBe("1");
    expect(formatMetricValue(254, "maxLogicalDepth")).toBe("254");
    expect(formatMetricValue(268, "scheduleCount")).toBe("268");
    expect(formatMetricValue(42, "blocksExecuted")).toBe("42");
    expect(formatDeltaPercent(159.4)).toBe("+159.4%");
    expect(formatDeltaPercent(-3.01)).toBe("-3.0%");
    // Near-zero / missing percentages render as an em dash, not a fabricated
    // number like "+0.0%".
    expect(formatDeltaPercent(null)).toBe("—");
  });
});
