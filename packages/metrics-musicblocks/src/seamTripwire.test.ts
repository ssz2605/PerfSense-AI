import { describe, it, expect } from "vitest";
import {
  checkTransportSeamAlive,
  FRERE_JACQUES_TRANSPORT_METRICS,
  analyzeAudioClock,
  SYNTHETIC_DRIFT_THRESHOLD_MS,
} from "./seamTripwire";

describe("checkTransportSeamAlive", () => {
  it("declares the seam alive when transport events actually fired", () => {
    const check = checkTransportSeamAlive({
      scheduleCount: 268,
      callbackLatencyMean: 12.4,
      callbackLatencyMax: 40.1,
      cumulativeDrift: 0.5,
      voiceOnsetError: 11.9,
    });
    expect(check.alive).toBe(true);
    expect(check.scheduledEvents).toBe(268);
  });

  it("declares the seam alive via audio observations even without a count", () => {
    const check = checkTransportSeamAlive({
      callbackLatencyMean: 12.4,
      cumulativeDrift: 0.5,
    } as Record<string, number | null>);
    expect(check.alive).toBe(true);
  });

  it("flags a dead seam when count is explicitly 0 and no observations exist", () => {
    const check = checkTransportSeamAlive({
      scheduleCount: 0,
      callbackLatencyMean: null,
      callbackLatencyMax: null,
      cumulativeDrift: null,
      voiceOnsetError: null,
    });
    expect(check.alive).toBe(false);
    expect(check.scheduledEvents).toBe(0);
    expect(check.reason).toContain("seam may be dead");
  });

  it("flags a dead seam when count was never recorded and nothing fired", () => {
    const check = checkTransportSeamAlive({
      scheduleCount: null,
      callbackLatencyMean: null,
      voiceOnsetError: null,
    } as Record<string, number | null>);
    expect(check.alive).toBe(false);
    expect(check.scheduledEvents).toBeNull();
  });

  it("treats count=0 but live observations as a warn signal, not a dead seam", () => {
    // count=0 with a single non-null latency could be a partial collector
    // reset, so observations keep the seam "alive" for now.
    const check = checkTransportSeamAlive({
      scheduleCount: 0,
      callbackLatencyMean: 12.0,
      callbackLatencyMax: null,
      cumulativeDrift: null,
      voiceOnsetError: null,
    });
    expect(check.alive).toBe(true);
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