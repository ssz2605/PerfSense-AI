import { describe, it, expect } from "vitest";
import {
  checkTransportSeamAlive,
  FRERE_JACQUES_TRANSPORT_METRICS,
  TRANSPORT_SEAM_ABSOLUTE_FLOOR,
  TRANSPORT_SEAM_MIN_SHARE_OF_BASELINE,
  analyzeAudioClock,
  SYNTHETIC_DRIFT_THRESHOLD_MS,
} from "./seamTripwire";

describe("checkTransportSeamAlive", () => {
  it("declares the seam alive when transport scheduling is measurably in use", () => {
    // Observed on Frere-Jacques: 268 transport.schedule calls vs 10330
    // setTimeout fallback delays. Low, but the transport path is in use.
    const check = checkTransportSeamAlive({
      transportEventRatio: 0.0253,
      callbackLatencyMean: 12.4,
      callbackLatencyMax: 40.1,
      cumulativeDrift: 0.5,
      voiceOnsetError: 11.9,
    });
    expect(check.alive).toBe(true);
    expect(check.transportEventRatio).toBe(0.0253);
  });

  it("declares the seam alive at a full 1.0 ratio", () => {
    const check = checkTransportSeamAlive({ transportEventRatio: 1.0 });
    expect(check.alive).toBe(true);
  });

  it("declares the seam alive via audio observations when no ratio was collected", () => {
    const check = checkTransportSeamAlive({
      callbackLatencyMean: 12.4,
      cumulativeDrift: 0.5,
    } as Record<string, number | null>);
    expect(check.alive).toBe(true);
    expect(check.transportEventRatio).toBeNull();
  });

  it("flags a dead seam when the ratio is explicitly 0", () => {
    const check = checkTransportSeamAlive({
      transportEventRatio: 0,
      callbackLatencyMean: null,
      callbackLatencyMax: null,
      cumulativeDrift: null,
      voiceOnsetError: null,
    });
    expect(check.alive).toBe(false);
    expect(check.transportEventRatio).toBe(0);
    expect(check.reason).toContain("below");
  });

  it("flags a dead seam when no ratio was recorded and nothing fired", () => {
    const check = checkTransportSeamAlive({
      transportEventRatio: null,
      callbackLatencyMean: null,
      voiceOnsetError: null,
    } as Record<string, number | null>);
    expect(check.alive).toBe(false);
    expect(check.transportEventRatio).toBeNull();
    expect(check.reason).toContain("seam may be dead");
  });

  it("flags a collapsed ratio even when audio observations look healthy", () => {
    // The audio-observation escape hatch must not mask a ratio that says every
    // note delay took the setTimeout fallback (logo.js:1841-1856).
    const check = checkTransportSeamAlive({
      transportEventRatio: 1e-9,
      callbackLatencyMean: 12.0,
      callbackLatencyMax: 40.0,
      cumulativeDrift: 0.5,
      voiceOnsetError: 11.9,
    });
    expect(check.alive).toBe(false);
    expect(check.reason).toContain("setTimeout fallback");
  });

  it("falls back to the absolute floor when there is no baseline share", () => {
    // The absolute floor only applies when nothing is on record to compare
    // against, so it can sit far under the healthy ~0.025.
    expect(TRANSPORT_SEAM_ABSOLUTE_FLOOR).toBe(0.001);
    expect(checkTransportSeamAlive({ transportEventRatio: 0.001 }).alive).toBe(true);
    expect(checkTransportSeamAlive({ transportEventRatio: 0.0009 }).alive).toBe(false);
    // A baseline of 0 carries no information, so it must not become a 0 floor.
    expect(
      checkTransportSeamAlive({ transportEventRatio: 0.0009 }, { baselineRatio: 0 }).alive,
    ).toBe(false);
    expect(
      checkTransportSeamAlive({ transportEventRatio: 0.0009 }, { baselineRatio: null }).alive,
    ).toBe(false);
  });

  it("gates on half the baseline share, not on an absolute 1.0", () => {
    // The seam's honest value is ~0.025 because Tone.Transport is never started.
    // A check that demanded 1.0 would fire on a correct run; demanding half the
    // baseline share asks the question that actually matters -- has the
    // transport path stopped carrying scheduling?
    const baselineRatio = 0.025;
    expect(
      checkTransportSeamAlive({ transportEventRatio: 0.025 }, { baselineRatio }).alive,
    ).toBe(true);
    // Exactly half the baseline is still alive (the boundary is inclusive).
    expect(
      checkTransportSeamAlive({ transportEventRatio: 0.0125 }, { baselineRatio }).alive,
    ).toBe(true);
    // Below half: dead, and the reason quotes the baseline it regressed against.
    const collapsed = checkTransportSeamAlive(
      { transportEventRatio: 0.0124 },
      { baselineRatio },
    );
    expect(collapsed.alive).toBe(false);
    expect(collapsed.reason).toContain("0.025");
    expect(collapsed.reason).toContain("0.5 of the baseline share");
    expect(collapsed.reason).toContain("setTimeout fallback");
  });

  it("catches a ratio that the absolute floor alone would have passed", () => {
    // 0.004 is 16% of the baseline share: 4x above the 0.001 absolute floor, so
    // the old fixed threshold called this healthy while the seam was in fact
    // three quarters gone.
    expect(checkTransportSeamAlive({ transportEventRatio: 0.004 }).alive).toBe(true);
    expect(
      checkTransportSeamAlive({ transportEventRatio: 0.004 }, { baselineRatio: 0.025 }).alive,
    ).toBe(false);
  });

  it("scales the floor with the baseline rather than hardcoding the healthy value", () => {
    // A different app (or a different runner) with a much larger transport share
    // must be held to a correspondingly larger floor.
    expect(TRANSPORT_SEAM_MIN_SHARE_OF_BASELINE).toBe(0.5);
    expect(
      checkTransportSeamAlive({ transportEventRatio: 0.3 }, { baselineRatio: 0.5 }).alive,
    ).toBe(true);
    expect(
      checkTransportSeamAlive({ transportEventRatio: 0.3 }, { baselineRatio: 0.9 }).alive,
    ).toBe(false);
  });

  it("still reports no-data as dead regardless of the baseline share", () => {
    const check = checkTransportSeamAlive(
      { transportEventRatio: null },
      { baselineRatio: 0.025 },
    );
    expect(check.alive).toBe(false);
    expect(check.reason).toContain("no transport data observed");
  });

  it("covers exactly the four Frère Jacques audio metrics", () => {
    expect(FRERE_JACQUES_TRANSPORT_METRICS).toEqual([
      "callbackLatencyMean",
      "callbackLatencyMax",
      "cumulativeDrift",
      "voiceOnsetError",
    ]);
  });
});

describe("analyzeAudioClock (Layer B canary)", () => {
  it("classifies sub-microsecond drift as a synthetic clock", () => {
    const analysis = analyzeAudioClock({ cumulativeDrift: 1.55e-9 });
    expect(analysis.clock).toBe("synthetic");
    expect(analysis.drift).toBe(1.55e-9);
  });

  it("classifies millisecond-scale drift as a real clock", () => {
    const analysis = analyzeAudioClock({ cumulativeDrift: 3.7 });
    expect(analysis.clock).toBe("real");
  });

  it("reports unknown when no drift was collected", () => {
    const analysis = analyzeAudioClock({ cumulativeDrift: null });
    expect(analysis.clock).toBe("unknown");
    const missing = analyzeAudioClock({});
    expect(missing.clock).toBe("unknown");
  });

  it("uses the documented threshold boundary", () => {
    expect(SYNTHETIC_DRIFT_THRESHOLD_MS).toBe(1e-6);
    expect(analyzeAudioClock({ cumulativeDrift: 1e-6 }).clock).toBe("synthetic");
    expect(analyzeAudioClock({ cumulativeDrift: 1.000001e-6 }).clock).toBe("real");
  });
});