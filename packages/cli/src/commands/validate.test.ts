import { describe, it, expect } from "vitest";
import type {
  BaselineData,
  BaselineMetricStatsV2,
  EnvironmentFingerprint,
} from "@perfsense/core";
import {
  detectBimodality,
  validateBaseline,
  renderValidity,
  VALIDITY_DEFAULTS,
} from "./validate";

const ENV: EnvironmentFingerprint = {
  os: "linux 5.15",
  arch: "x64",
  node: "v20.11.0",
  cpu: "Xeon",
  cores: 4,
  memoryGB: 16,
  coldState: true,
};

function stats(values: number[]): BaselineMetricStatsV2 {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1),
  );
  return {
    median,
    p10: sorted[0],
    p90: sorted[sorted.length - 1],
    values,
    mean,
    sd,
    mad: 0,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p25: sorted[Math.floor(sorted.length * 0.25)],
    p75: sorted[Math.floor(sorted.length * 0.75)],
    cv: mean === 0 ? Infinity : sd / Math.abs(mean),
    n: values.length,
    invalid: 0,
    stability: { tier: "stable", flagged: false },
  };
}

/** A baseline carrying exactly the fixtures/metrics a test cares about. */
function baseline(
  pages: BaselineData["pages"],
  overrides: Partial<BaselineData> = {},
): BaselineData {
  return {
    schema: "perfsense-baseline-v2",
    schemaVersion: 2,
    createdAt: "2026-09-20T00:00:00.000Z",
    generatedAt: "2026-09-20T00:00:00.000Z",
    runs: 5,
    pages,
    source: "test",
    commitSHA: "abc123",
    harness: { ref: "deadbee", source: "PERFSENSE_REF" },
    env: ENV,
    ...overrides,
  };
}

/** Every fixture/metric the matrix approves, all tight and stable. */
function healthyPages(): BaselineData["pages"] {
  return {
    "index.html": {
      bootstrapTotal: stats([5300, 5310, 5320, 5330, 5340]),
      initTotal: stats([250, 251, 252, 253, 254]),
      heapAfterBoot: stats([47.4e6, 47.5e6, 47.6e6, 47.7e6, 47.8e6]),
    },
    "RainbowConnection.html": {
      projectLoadTime: stats([9000, 9010, 9020, 9030, 9040]),
      saveTime: stats([150, 151, 152, 153, 154]),
      exportMIDITime: stats([1700, 1710, 1720, 1730, 1740]),
      saveAsLilypondTime: stats([1500, 1510, 1520, 1530, 1540]),
      // stageUpdateCallCount counts stage.update() frames since openStart; the
      // value here reflects _suppressRefresh keeping the loop idle during decode.
      stageUpdateCallCount: stats([1140, 1150, 1145, 1155, 1148]),
      peakHeapDuringExport: stats([27.0e6, 27.1e6, 27.2e6, 27.3e6, 27.4e6]),
      maxDepth: stats([100, 100, 100, 100, 100]),
      // PR #7923's witnesses: suppressed load paints almost nothing.
      refreshCanvasCallCount: stats([11, 11, 11, 11, 11]),
      stageUpdateTime: stats([8.46, 8.52, 8.49, 8.55, 8.5]),
      stageUpdateMax: stats([20.02, 20.18, 20.09, 20.24, 20.11]),
      cacheRebuildCount: stats([242, 245, 244, 243, 246]),
      viewportCulledBlocks: stats([794, 796, 797, 795, 796]),
    },
    "Frere-Jacques.html": {
      callbackLatencyMean: stats([0.5, 0.501, 0.502, 0.503, 0.504]),
      callbackLatencyMax: stats([1.2, 1.21, 1.22, 1.23, 1.24]),
      cumulativeDrift: stats([1.5e-9, 1.51e-9, 1.52e-9, 1.53e-9, 1.54e-9]),
      voiceOnsetError: stats([0.48, 0.481, 0.482, 0.483, 0.49]),
      // 268 transport.schedule calls vs 10330 setTimeout fallback delays.
      transportEventRatio: stats([0.0251, 0.0254, 0.0253, 0.0252, 0.0255]),
      // 268 transport.schedule calls vs 10330 setTimeout fallback delays.
      transportEventCount: stats([268, 268, 268, 268, 268]),
      // A floor: healthy is 0 (synths stopped after completion).
      synthsRetained: stats([0, 0, 0, 0, 0]),
    },
    "musical-tree.html": {
      maxQueueDepth: stats([22, 22, 22, 22, 22]),
      executionTime: stats([41000, 41100, 41200, 41300, 41400]),
      memoryDelta: stats([0, 0, 0, 0, 0]),
      retainedHeap: stats([0, 0, 0, 0, 0]),
      // #7848 invariants: a natural completion preserves the drawing, and N
      // completions accumulate neither ink nor heap. Values are deliberately
      // tight because this fixture must read as a *clean* capture; the real
      // spreads are still to be characterized over 5 runs.
      canvasInkCoverage: stats([0.421, 0.419, 0.423, 0.42, 0.422]),
      canvasInkDrift: stats([0.00114, 0.001155, 0.00115, 0.00116, 0.0011525]),
      retainedHeapSlope: stats([11980, 12100, 12030, 12150, 12080]),
      synthsRetained: stats([0, 0, 0, 0, 0]),
    },
    "ascending-notes-color-spiral.html": {
      executionTime: stats([2000, 2010, 2020, 2030, 2040]),
      blocksExecuted: stats([178, 178, 178, 178, 178]),
    },
    "crabcanon-plot.html": {
      // The render cells that replaced the retired scheduleLag probes
      // (~1e-11 ms, below timer resolution, hence constant on unchanged code).
      stageUpdateTime: stats([8.46, 8.52, 8.49, 8.55, 8.5]),
      stageUpdateMax: stats([20.02, 20.18, 20.09, 20.24, 20.11]),
      cacheRebuildCount: stats([242, 245, 244, 243, 246]),
      cacheSkippedCount: stats([687, 687, 687, 687, 687]),
      viewportCulledBlocks: stats([794, 796, 797, 795, 796]),
      viewportCulledFraction: stats([0.855, 0.855, 0.855, 0.855, 0.855]),
      transportEventRatio: stats([0.0251, 0.0254, 0.0253, 0.0252, 0.0255]),
    },
  };
}

/**
 * A capture that still carries the cells retired from the contract. `baseline
 * save` filters these out, so this is the shape of a hand-edited or pre-retirement
 * baseline — it must be reported, not silently accepted.
 */
function pagesWithRetiredCells(): ReturnType<typeof healthyPages> {
  const pages = healthyPages() as Record<string, Record<string, unknown>>;
  pages["Frere-Jacques.html"].scheduleCount = stats([268, 268, 268, 268, 268]);
  pages["RainbowConnection.html"].logoSoundsRetained = stats([0, 0, 0, 0, 0]);
  pages["Frere-Jacques.html"].executionTime = stats([
    4200, 4210, 4220, 4230, 4240,
  ]);
  pages["Frere-Jacques.html"].blocksExecuted = stats([228, 228, 228, 228, 228]);
  pages["Frere-Jacques.html"].maxQueueDepth = stats([6, 6, 6, 6, 6]);
  pages["musical-tree.html"].maxLogicalDepth = stats([254, 254, 254, 254, 254]);
  pages["ascending-notes-color-spiral.html"].maxLogicalDepth = stats([
    27, 27, 27, 27, 27,
  ]);
  pages["crabcanon-plot.html"].executionTime = stats([
    24000, 24100, 24200, 24300, 24400,
  ]);
  pages["crabcanon-plot.html"].blocksExecuted = stats([
    2078, 2078, 2078, 2078, 2078,
  ]);
  pages["crabcanon-plot.html"].maxQueueDepth = stats([10, 10, 10, 10, 10]);
  // The below-resolution lag probes retired from the crabcanon contract.
  pages["crabcanon-plot.html"].scheduleLagMean = stats([
    5.8e-12, 5.9e-12, 6e-12, 6.1e-12, 6.2e-12,
  ]);
  pages["crabcanon-plot.html"].scheduleLagMax = stats([
    2.1e-11, 2.2e-11, 2.3e-11, 2.4e-11, 2.5e-11,
  ]);
  return pages as ReturnType<typeof healthyPages>;
}

function kinds(validity: ReturnType<typeof validateBaseline>): string[] {
  return validity.defects.map((d) => d.kind);
}

function findDefect(
  validity: ReturnType<typeof validateBaseline>,
  metric: string,
  kind: string,
) {
  return validity.defects.find((d) => d.metric === metric && d.kind === kind);
}

describe("detectBimodality", () => {
  const { bimodalGapRatio, bimodalShiftPct } = VALIDITY_DEFAULTS;

  it("finds the two clusters in the corrupted projectLoadTime capture", () => {
    const split = detectBimodality(
      [9409.8, 9421.2, 11696.8, 11840.1, 12026.8],
      bimodalGapRatio,
      bimodalShiftPct,
    );
    expect(split).not.toBeNull();
    expect(split!.bimodal).toBe(true);
    expect(split!.shiftPct).toBeGreaterThan(20);
  });

  it("finds the two clusters in the corrupted exportMIDITime capture", () => {
    const split = detectBimodality(
      [2290.5, 2291.3, 2318.5, 2525.9, 2700.2],
      bimodalGapRatio,
      bimodalShiftPct,
    );
    expect(split!.bimodal).toBe(true);
  });

  it("does not fire on a stable metric with ordinary jitter", () => {
    expect(
      detectBimodality(
        [5300, 5310, 5320, 5330, 5340],
        bimodalGapRatio,
        bimodalShiftPct,
      )!.bimodal,
    ).toBe(false);
  });

  it("does not fire when one large gap barely separates the medians", () => {
    // One slow sample out of five: a real outlier, not two conditions.
    expect(
      detectBimodality(
        [9000, 9010, 9020, 9030, 11000],
        bimodalGapRatio,
        bimodalShiftPct,
      )!.bimodal,
    ).toBe(false);
  });

  it("reports an unbounded ratio when every other gap is zero", () => {
    const split = detectBimodality(
      [10, 10, 10, 500, 500],
      bimodalGapRatio,
      bimodalShiftPct,
    );
    expect(split!.gapRatio).toBe(Infinity);
    expect(split!.bimodal).toBe(true);
  });

  it("needs four samples to hold two clusters", () => {
    expect(
      detectBimodality([1, 2, 3], bimodalGapRatio, bimodalShiftPct),
    ).toBeNull();
  });

  it("does not fire when the split leaves a one-sample cluster", () => {
    const split = detectBimodality(
      [10, 10, 10, 10, 9000],
      bimodalGapRatio,
      bimodalShiftPct,
    );
    expect(split!.bimodal).toBe(false);
  });
});

describe("validateBaseline", () => {
  it("passes a clean capture with per-metric spread limits configured", () => {
    const result = validateBaseline(baseline(healthyPages()), {
      validity: {
        maxSpreadPct: { bootstrapTotal: 10, initTotal: 8, saveTime: 10 },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.defects.filter((d) => d.severity === "fail")).toHaveLength(0);
  });

  it("fails captures that do not exercise required transport, refresh, or export paths", () => {
    const pages = healthyPages();
    pages["Frere-Jacques.html"].transportEventCount = stats([268, 0, 268, 268, 268]);
    pages["RainbowConnection.html"].refreshCanvasCallCount = stats([0, 0, 0, 0, 0]);
    pages["RainbowConnection.html"].maxDepth = stats([1, 1, 1, 1, 1]);

    const result = validateBaseline(baseline(pages));

    expect(result.ok).toBe(false);
    for (const metric of ["transportEventCount", "refreshCanvasCallCount", "maxDepth"]) {
      const defect = findDefect(result, metric, "zero-variance");
      expect(defect?.severity).toBe("fail");
      expect(defect?.detail).toContain("not exercised");
    }
  });

  it("warns rather than fails a spread with no configured limit", () => {
    const result = validateBaseline(baseline(healthyPages()));
    const warn = findDefect(result, "saveTime", "spread");
    expect(warn?.severity).toBe("warn");
    expect(warn?.detail).toContain("no maxSpreadPct configured");
    expect(result.ok).toBe(true);
  });

  it("fails a spread that exceeds its configured limit", () => {
    const pages = healthyPages();
    pages["index.html"].initTotal = stats([220, 240, 250, 255, 258]);
    const result = validateBaseline(baseline(pages), {
      validity: { maxSpreadPct: { initTotal: 8 } },
    });
    expect(result.ok).toBe(false);
    expect(findDefect(result, "initTotal", "spread")?.severity).toBe("fail");
  });

  it("fails a bimodal capture even with no spread limits configured", () => {
    const pages = healthyPages();
    pages["RainbowConnection.html"].projectLoadTime = stats([
      9409.8, 9421.2, 11696.8, 11840.1, 12026.8,
    ]);
    const result = validateBaseline(baseline(pages));
    expect(result.ok).toBe(false);
    expect(findDefect(result, "projectLoadTime", "bimodal")?.severity).toBe(
      "fail",
    );
  });

  it("does not demand a tight distribution from a probe below timer resolution", () => {
    // cumulativeDrift is the cell that is genuinely below the resolution floor
    // in the approved contract: a sub-nanosecond drift cannot be measured by a
    // millisecond timer, so its p10->p90 span is meaningless as noise. The
    // scheduleLag probes used to cover this case but left the crabcanon
    // contract, because on unchanged code they are constant -- below resolution
    // AND zero variance, which says nothing about a capture either way.
    const pages = healthyPages();
    pages["Frere-Jacques.html"].cumulativeDrift = stats([
      1e-12, 9e-12, 3e-11, 7e-11, 2.1e-10,
    ]);
    const result = validateBaseline(baseline(pages), {
      validity: { maxSpreadPct: { cumulativeDrift: 1 } },
    });
    expect(
      findDefect(result, "cumulativeDrift", "below-resolution")?.severity,
    ).toBe("warn");
    expect(findDefect(result, "cumulativeDrift", "spread")).toBeUndefined();
    expect(findDefect(result, "cumulativeDrift", "bimodal")).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("reports a probe that measured nothing as zero-variance, not as a pass", () => {
    const result = validateBaseline(baseline(healthyPages()));
    expect(findDefect(result, "memoryDelta", "zero-variance")?.severity).toBe(
      "warn",
    );
    expect(findDefect(result, "retainedHeap", "zero-variance")?.severity).toBe(
      "warn",
    );
  });

  it("fails a cell with too few valid samples to classify", () => {
    const pages = healthyPages();
    pages["index.html"].bootstrapTotal = stats([5300, 5310, 5320]);
    const result = validateBaseline(baseline(pages));
    expect(result.ok).toBe(false);
    expect(
      findDefect(result, "bootstrapTotal", "insufficient-samples")?.detail,
    ).toContain("3 valid samples");
  });

  it("flags an approved metric the capture never measured", () => {
    const pages = healthyPages();
    delete pages["musical-tree.html"].executionTime;
    const result = validateBaseline(baseline(pages));
    const missing = findDefect(result, "executionTime", "missing-metric");
    expect(missing?.severity).toBe("warn");
    expect(missing?.detail).toContain("NO_BASELINE");
  });

  it("flags every cell retired from the contract as an orphan", () => {
    // The metrics are still collected, but a baseline carrying them is either
    // hand-edited or pre-retirement. Either way they are never compared, and
    // that must be visible rather than counted as coverage.
    const result = validateBaseline(baseline(pagesWithRetiredCells()));
    const orphans = result.defects.filter((d) => d.kind === "orphan-cell");
    // Nine retired cells, plus the two crabcanon lag probes that left the
    // contract as constant-on-unchanged-code (below timer resolution), plus
    // Rainbow's logoSoundsRetained, which left the matrix entirely.
    expect(orphans.length).toBe(12);
    for (const metric of [
      "scheduleCount",
      "blocksExecuted",
      "maxLogicalDepth",
      "scheduleLagMean",
      "scheduleLagMax",
    ]) {
      expect(orphans.some((d) => d.metric === metric)).toBe(true);
    }
    // Reported, never blocking.
    expect(result.ok).toBe(true);
  });

  it("flags a whole fixture the capture never ran", () => {
    const pages = healthyPages();
    delete pages["ascending-notes-color-spiral.html"];
    const result = validateBaseline(baseline(pages));
    const missing = result.defects.find((d) => d.kind === "missing-fixture");
    expect(missing?.fixture).toBe("ascending-notes-color-spiral.html");
    expect(missing?.metric).toBeNull();
  });

  it("flags a cell the matrix no longer approves as an orphan", () => {
    const pages = healthyPages();
    (pages["musical-tree.html"] as Record<string, unknown>).maxDepth = stats([
      178, 178, 178, 178, 178,
    ]);
    const result = validateBaseline(baseline(pages));
    const orphan = findDefect(result, "maxDepth", "orphan-cell");
    expect(orphan?.severity).toBe("warn");
    expect(orphan?.detail).toContain("never compared");
  });

  it("rejects a capture taken on a CPU-constrained runner", () => {
    const throttled: EnvironmentFingerprint = {
      ...ENV,
      cpuQuota: { quotaCpus: 2, throttled: true, source: "cgroup-v2" },
    };
    const result = validateBaseline(
      baseline(healthyPages(), { env: throttled }),
    );
    expect(result.ok).toBe(false);
    expect(
      result.defects.some((d) => d.detail.includes("CPU-constrained runner")),
    ).toBe(true);
  });

  it("tolerates an unknown CPU quota", () => {
    const unknown: EnvironmentFingerprint = {
      ...ENV,
      cpuQuota: { quotaCpus: null, throttled: null, source: "unavailable" },
    };
    const result = validateBaseline(baseline(healthyPages(), { env: unknown }));
    expect(result.ok).toBe(true);
  });

  it("tolerates a baseline with no environment fingerprint at all", () => {
    const result = validateBaseline(
      baseline(healthyPages(), { env: undefined }),
    );
    expect(result.ok).toBe(true);
  });

  describe("count-metric quantization floor", () => {
    it("does not fail a count metric whose limit is finer than one unit", () => {
      // Real case: maxQueueDepth median 8, p10 8 -> p90 10 is a one-unit
      // rounding step, but a 20% limit reads it as 25% of noise.
      const pages = healthyPages();
      pages["musical-tree.html"].maxQueueDepth = stats([8, 8, 8, 10, 10]);
      const result = validateBaseline(baseline(pages), {
        validity: { maxSpreadPct: { maxQueueDepth: 20 } },
      });
      expect(findDefect(result, "maxQueueDepth", "spread")).toBeUndefined();
      expect(result.ok).toBe(true);
    });

    it("still reports the misconfiguration when the spread is real", () => {
      const pages = healthyPages();
      pages["musical-tree.html"].maxQueueDepth = stats([2, 7, 8, 9, 15]);
      const result = validateBaseline(baseline(pages), {
        validity: { maxSpreadPct: { maxQueueDepth: 20 } },
      });
      const d = findDefect(result, "maxQueueDepth", "spread");
      expect(d?.severity).toBe("warn");
      expect(d?.detail).toContain("quantization floor");
      expect(result.ok).toBe(true);
    });

    it("gates a count metric normally once its limit clears the floor", () => {
      // Median 8 -> floor 25%, so a 40% limit is a genuine tolerance.
      const pages = healthyPages();
      pages["musical-tree.html"].maxQueueDepth = stats([4, 5, 6, 12, 14]);
      const result = validateBaseline(baseline(pages), {
        validity: { maxSpreadPct: { maxQueueDepth: 40 } },
      });
      expect(findDefect(result, "maxQueueDepth", "spread")?.severity).toBe(
        "fail",
      );
      expect(result.ok).toBe(false);
    });

    it("does not exempt a continuous metric with the same shape", () => {
      const pages = healthyPages();
      pages["index.html"].initTotal = stats([100, 101, 102, 140, 141]);
      const result = validateBaseline(baseline(pages), {
        validity: { maxSpreadPct: { initTotal: 5 } },
      });
      expect(findDefect(result, "initTotal", "spread")?.severity).toBe("fail");
    });
  });

  describe("divergence against the baseline being replaced", () => {
    const previous = baseline(healthyPages());

    it("fails movement on the same commit and the same runner", () => {
      const pages = healthyPages();
      pages["index.html"].initTotal = stats([340, 341, 342, 343, 344]);
      const result = validateBaseline(baseline(pages), { previous });
      expect(result.comparedWithPrevious).toBe(true);
      expect(result.ok).toBe(false);
      const d = findDefect(result, "initTotal", "divergence");
      expect(d?.severity).toBe("fail");
      expect(d?.detail).toContain("earlier capture is the suspect one");
    });

    it("issues no verdict when the app commit moved", () => {
      const pages = healthyPages();
      pages["index.html"].initTotal = stats([340, 341, 342, 343, 344]);
      const result = validateBaseline(
        baseline(pages, { commitSHA: "def456" }),
        { previous },
      );
      expect(result.ok).toBe(true);
      expect(findDefect(result, "initTotal", "divergence")).toBeUndefined();
    });

    it("issues no verdict when the runner changed", () => {
      const pages = healthyPages();
      pages["index.html"].initTotal = stats([340, 341, 342, 343, 344]);
      const movedEnv = { ...ENV, cpu: "EPYC", cores: 8 };
      const result = validateBaseline(baseline(pages, { env: movedEnv }), {
        previous,
      });
      expect(result.ok).toBe(true);
    });

    it("does not compare when no previous baseline is supplied", () => {
      const result = validateBaseline(baseline(healthyPages()));
      expect(result.comparedWithPrevious).toBe(false);
    });
  });

  it("reports a clean capture as committable", () => {
    const b = baseline(healthyPages());
    const result = validateBaseline(b, {
      validity: {
        maxSpreadPct: {
          saveTime: 10,
          exportMIDITime: 10,
          saveAsLilypondTime: 10,
          callbackLatencyMax: 10,
          voiceOnsetError: 10,
        },
      },
    });
    expect(result.ok).toBe(true);
    // Nothing left but the probes that genuinely cannot measure anything. The
    // four zero-variance cells: memoryDelta, retainedHeap, and the two
    // synthsRetained cells. The one below-resolution cell is cumulativeDrift.
    // The crabcanon scheduleLag probes used to be the other two; they left the
    // contract because on unchanged code they are constant, which is zero
    // variance rather than a below-resolution reading.
    expect(result.defects.map((d) => `${d.metric}:${d.kind}`).sort()).toEqual([
      "cumulativeDrift:below-resolution",
      "memoryDelta:zero-variance",
      "retainedHeap:zero-variance",
      "synthsRetained:zero-variance",
      "synthsRetained:zero-variance",
    ]);
  });

  it("stays silent about an unconfigured metric whose spread is negligible", () => {
    const pages = healthyPages();
    pages["index.html"].bootstrapTotal = stats([5300, 5301, 5302, 5303, 5304]);
    const result = validateBaseline(baseline(pages));
    expect(findDefect(result, "bootstrapTotal", "spread")).toBeUndefined();
  });
});

describe("renderValidity", () => {
  it("names the harness and the runner load in the audit header", () => {
    const env: EnvironmentFingerprint = {
      ...ENV,
      loadAvg1m: 3.42,
      cpuQuota: { quotaCpus: 4, throttled: false, source: "cgroup-v2" },
    };
    const out = renderValidity(
      baseline(healthyPages(), { env }),
      validateBaseline(baseline(healthyPages(), { env })),
    );
    expect(out).toContain("## Baseline validity");
    expect(out).toContain("harness=deadbee");
    expect(out).toContain("Runner 1-minute load average at capture: 3.42");
    expect(out).toContain("throttled=false");
  });

  it("does not claim an unreadable quota is unrestricted", () => {
    const unknown: EnvironmentFingerprint = {
      ...ENV,
      cpuQuota: { quotaCpus: null, throttled: null, source: "unavailable" },
    };
    const b = baseline(healthyPages(), { env: unknown });
    const out = renderValidity(b, validateBaseline(b));
    expect(out).toContain("Runner CPU quota: unknown (unavailable)");
    expect(out).not.toContain("unrestricted");
  });

  it("says explicitly when the capture ran without a harness ref", () => {
    const unfingerprinted = baseline(healthyPages(), {
      harness: {
        ref: null,
        source: "unavailable",
        reason: "PERFSENSE_REF is not set.",
      },
    });
    const out = renderValidity(
      unfingerprinted,
      validateBaseline(unfingerprinted),
    );
    expect(out).toContain("unavailable (PERFSENSE_REF is not set.)");
  });

  it("reports a clean capture", () => {
    const b = baseline(healthyPages());
    expect(renderValidity(b, validateBaseline(b))).toContain(
      "no blocking defects",
    );
  });
});

describe("renderValidity with nothing to report", () => {
  it("says so plainly", () => {
    const b = baseline(healthyPages());
    const out = renderValidity(b, {
      ok: true,
      defects: [],
      comparedWithPrevious: false,
      fixtureCount: 6,
      metricCount: 28,
    });
    expect(out).toContain("No defects found.");
  });

  it("says so when only warnings were raised", () => {
    const b = baseline(healthyPages());
    const out = renderValidity(b, {
      ok: true,
      defects: [
        {
          fixture: "musical-tree.html",
          metric: "memoryDelta",
          kind: "zero-variance",
          severity: "warn",
          detail: "median is 0 across all 5 samples",
        },
      ],
      comparedWithPrevious: false,
      fixtureCount: 6,
      metricCount: 28,
    });
    expect(out).toContain("1 warning(s), no blocking defects.");
    expect(out).toContain("The baseline can be committed.");
  });

  it("names the defect count when something blocks", () => {
    const pages = healthyPages();
    pages["index.html"].bootstrapTotal = stats([5300, 5310]);
    const b = baseline(pages);
    const out = renderValidity(b, validateBaseline(b));
    expect(out).toContain("blocking defect(s)");
    expect(out).toContain("The baseline was not committed.");
    expect(out).toContain("insufficient-samples");
  });
});

describe("defect kinds are exhaustive over what the gate can report", () => {
  it("never reports an unknown kind", () => {
    const known = new Set([
      "bimodal",
      "spread",
      "divergence",
      "below-resolution",
      "zero-variance",
      "insufficient-samples",
      "orphan-cell",
      "missing-metric",
      "missing-fixture",
    ]);
    const pages = healthyPages();
    (pages["musical-tree.html"] as Record<string, unknown>).maxDepth = stats([
      1, 1, 1, 1, 1,
    ]);
    pages["index.html"].initTotal = stats([200, 250, 255, 260, 265]);
    delete pages["ascending-notes-color-spiral.html"];
    pages["crabcanon-plot.html"].scheduleLagMean = stats([
      1e-13, 2e-13, 3e-13, 4e-13, 5e-13,
    ]);
    pages["musical-tree.html"].maxQueueDepth = stats([228, 229, 230]);
    const b = baseline(pages);
    const result = validateBaseline(b, {
      previous: baseline(healthyPages()),
      validity: { maxSpreadPct: { initTotal: 5 } },
    });
    expect(result.defects.length).toBeGreaterThan(5);
    for (const kind of kinds(result)) expect(known.has(kind)).toBe(true);
  });
});
