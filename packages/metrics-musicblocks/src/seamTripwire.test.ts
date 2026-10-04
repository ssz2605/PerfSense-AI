import { describe, it, expect } from "vitest";
import {
  checkTransportSeamAlive,
  FRERE_JACQUES_TRANSPORT_METRICS,
  TRANSPORT_SEAM_MIN_RATIO,
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

  it("uses the documented floor boundary", () => {
    expect(TRANSPORT_SEAM_MIN_RATIO).toBe(0.001);
    expect(checkTransportSeamAlive({ transportEventRatio: 0.001 }).alive).toBe(true);
    expect(checkTransportSeamAlive({ transportEventRatio: 0.0009 }).alive).toBe(false);
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