import { describe, expect, it } from "vitest";
import type { PageResult } from "@perfsense/core";
import { findRequiredFailures } from "./requiredMetrics";

function result(
  page: string,
  metrics: Record<string, number | null>,
): PageResult {
  return { page, runs: [{ run: 1, metrics }] };
}

describe("findRequiredFailures", () => {
  it("accepts finite samples for every required fingerprint", () => {
    const failures = findRequiredFailures([
      result("RainbowConnection.html", {
        refreshCanvasCallCount: 4,
        maxDepth: 100,
      }),
      result("Frere-Jacques.html", {
        transportEventRatio: 0.0253,
        transportEventCount: 268,
      }),
      result("crabcanon-plot.html", {
        cacheRebuildCount: 3,
        cacheSkippedCount: 4,
        viewportCulledBlocks: 10,
        viewportCulledFraction: 0.5,
      }),
      result("musical-tree.html", {
        canvasInkCoverage: 0.15,
        canvasInkDrift: 0,
        synthsRetained: 0,
      }),
    ]);
    expect(failures).toEqual([]);
  });

  it("flags null required values and an entirely missing fixture", () => {
    const failures = findRequiredFailures([
      result("Frere-Jacques.html", {
        transportEventRatio: null,
        transportEventCount: 268,
      }),
    ]);
    expect(failures).toContainEqual(
      expect.objectContaining({
        fixture: "Frere-Jacques.html",
        metric: "transportEventRatio",
      }),
    );
    expect(failures).toContainEqual(
      expect.objectContaining({
        fixture: "RainbowConnection.html",
        metric: "refreshCanvasCallCount",
        reason: expect.stringContaining("fixture missing"),
      }),
    );
  });
});
