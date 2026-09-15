import { describe, it, expect } from 'vitest';
import { computeScheduleLag } from './scheduleLag';

describe('computeScheduleLag', () => {
  it('measures audio-timeline drift, not wall-clock callback latency', () => {
    // Large wall-clock latency (schedule() call to callback fire) but audio
    // intervals exactly matching the requested schedule: callbackLatency would
    // be large, scheduleLag must be ~0.
    const scheduledTx = [0, 0.5, 1.0, 1.5];
    const firedAudio = [10.0, 10.5, 11.0, 11.5]; // aligned, just offset in time
    expect(computeScheduleLag(scheduledTx, firedAudio)).toEqual({ mean: 0, max: 0 });
  });

  it('reports large lag when audio intervals drift while wall clock stays flat', () => {
    // Audio fires 50ms late on the second interval and 20ms early on the third:
    // a constant callback latency would leave wall-clock deltas flat, but the
    // audio clock clearly deviates from the schedule.
    const scheduledTx = [0, 0.5, 1.0, 1.5];
    const firedAudio = [10.0, 10.55, 10.95, 11.5];
    // interval deltas: +0.55s vs 0.50s -> 50ms; 10.95-10.55=0.40
    // (|400-500| = 100ms), 11.5-10.95=0.55 -> 50ms.
    const lag = computeScheduleLag(scheduledTx, firedAudio);
    expect(lag.mean).toBeCloseTo((50 + 100 + 50) / 3, 5);
    expect(lag.max as number).toBeCloseTo(100, 5);
  });

  it('returns mean and max of per-event lag magnitudes', () => {
    const scheduledTx = [0, 1.0, 2.0, 3.0];
    const firedAudio = [100, 101.02, 101.98, 103.05];
    // deltas: 1.02s -> 20ms; 0.96s -> 40ms; 1.07s -> 70ms
    const lag = computeScheduleLag(scheduledTx, firedAudio);
    expect(lag.max as number).toBeCloseTo(70, 5);
    expect(lag.mean).toBeCloseTo((20 + 40 + 70) / 3, 5);
  });

  it('returns nulls when fewer than two aligned events exist', () => {
    expect(computeScheduleLag([], [])).toEqual({ mean: null, max: null });
    expect(computeScheduleLag([0.5], [10.0])).toEqual({ mean: null, max: null });
    expect(computeScheduleLag([null, 0.5], [null, 10.0])).toEqual({ mean: null, max: null });
  });

  it('skips pairs with missing timestamps instead of misaligning', () => {
    const scheduledTx = [0, null, 1.0, 1.5];
    const firedAudio = [10, null, 11.2, 11.5];
    // Only the (1.0, 1.5) vs (11.2, 11.5) pair is evaluated: 0.5s vs 0.3s -> 200ms.
    const lag = computeScheduleLag(scheduledTx, firedAudio);
    expect(lag.mean).toBeCloseTo(200, 5);
    expect(lag.max as number).toBeCloseTo(200, 5);
  });

  it('is independent of callback latency: identical callback delays, different lags', () => {
    // Two runs with the same wall-clock spacing between schedule() and fire
    // (fixed +500ms callback latency) must produce different scheduleLag when
    // the audio intervals differ — proving the metric is not a callback
    // latency proxy.
    const scheduledTx = [0, 0.5, 1.0, 1.5];
    const aligned = computeScheduleLag(scheduledTx, [10.0, 10.5, 11.0, 11.5]);
    const shuffled = computeScheduleLag(scheduledTx, [10.0, 10.5, 11.2, 11.6]);
    expect(aligned.mean).toBe(0);
    expect(aligned.max).toBe(0);
    expect(shuffled.mean).toBeGreaterThan(0);
    expect(shuffled.max).toBeGreaterThan(0);
  });
});