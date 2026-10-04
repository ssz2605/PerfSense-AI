/**
 * #7703 seam tripwire (Layer A) — deterministic, clock-independent.
 *
 * The Tone.Transport scheduling seam is the whole basis of the Frère Jacques
 * audio metrics. If playback scheduling were ever reverted to setTimeout, the
 * transport collector records zero scheduled events and all four audio metrics
 * come back null. This check turns "no data" into an explicit finding rather
 * than an empty row.
 *
 * The signal is transportEventRatio, not the retired scheduleCount.
 * scheduleCount was dropped from the contract, so driver.ts:129-135 no longer
 * collects it and it read null on every run — which made this check
 * vacuously fall through to the audio-observation branch and could never
 * distinguish "seam dead" from "counter not collected". transportEventRatio is
 * approved on both audio fixtures, so it is always present, and it is a
 * strictly stronger signal: it counts BOTH sides of the seam
 * (logo.js:1841-1856), so it falls off 1.0 the moment scheduling reverts
 * rather than merely reporting an absolute zero.
 */

export const FRERE_JACQUES_TRANSPORT_METRICS = [
  "callbackLatencyMean",
  "callbackLatencyMax",
  "cumulativeDrift",
  "voiceOnsetError",
] as const;

export interface TransportSeamCheck {
  alive: boolean;
  /** transportEventRatio, when the collector reported it. */
  transportEventRatio: number | null;
  reason?: string;
}

/**
 * The ratio below which the transport seam is considered dead. Locally the
 * honest value on Frère Jacques is ~0.025 (268 transport.schedule calls vs
 * 10330 setTimeout fallback delays), because the app schedules note *delays*
 * through Tone.Transport only opportunistically — Tone.Transport is never
 * started (transportState stays "stopped") even though Tone.context.state is
 * "running". So this is a floor well under 1, not a near-1.0 threshold: it
 * fires only when the transport path is entirely absent, which is the
 * regression this tripwire exists to catch. A ratio at or above this value
 * means transport.schedule did fire.
 */
export const TRANSPORT_SEAM_MIN_RATIO = 0.001;

export function checkTransportSeamAlive(
  metrics: Record<string, number | null>,
): TransportSeamCheck {
  const ratio =
    typeof metrics.transportEventRatio === "number" ? metrics.transportEventRatio : null;
  const observations = FRERE_JACQUES_TRANSPORT_METRICS.filter(
    (m) => typeof metrics[m] === "number",
  ).length;

  // The collector reported a share, and the transport path is still in use.
  if (ratio !== null && ratio >= TRANSPORT_SEAM_MIN_RATIO) {
    return { alive: true, transportEventRatio: ratio };
  }
  // The collector reported a share but the transport path is gone.
  if (ratio !== null) {
    return {
      alive: false,
      transportEventRatio: ratio,
      reason:
        `transportEventRatio ${ratio} is below ${TRANSPORT_SEAM_MIN_RATIO}: note scheduling is going through the setTimeout fallback (logo.js:1841-1856) instead of Tone.Transport, so the #7703 seam has regressed`,
    };
  }
  // No ratio collected at all. Audio observations alone are weaker evidence
  // (they can survive on a synthesised clock) but are still not "no data".
  if (observations > 0) {
    return { alive: true, transportEventRatio: null };
  }
  return {
    alive: false,
    transportEventRatio: null,
    reason:
      "no transport data observed (transportEventRatio is null or 0 and all audio metrics are null); the Tone.Transport seam may be dead, e.g. playback scheduling reverted to setTimeout",
  };
}

/**
 * #7703 Layer B — audio-clock canary (standalone, NOT part of the baseline).
 *
 * Headless Chromium runs on a synthesized audio clock: schedule-wall times and
 * fired times come from the same source, so cumulative drift collapses to ~0
 * (sub-nanosecond) and voice-onset/latency magnitudes are not representative of
 * a real output device. This pure helper classifies a results row's clock
 * provenance so a future gate can downgrade audio metrics automatically when
 * the values were gathered on a synthetic clock. Deliberately not wired into
 * the report/statistical path yet.
 */

export type AudioClockProvenance = "real" | "synthetic" | "unknown";

export interface AudioClockAnalysis {
  clock: AudioClockProvenance;
  /** cumulativeDrift value observed (null when the collector never fired). */
  drift: number | null;
  signature: string;
}

/**
 * A real audio clock drifts by milliseconds over a run; a synthesized clock
 * reports near-perfect agreement. Runs whose drift is below this absolute
 * threshold are treated as synthetic-clock measurements.
 */
export const SYNTHETIC_DRIFT_THRESHOLD_MS = 1e-6;

export function analyzeAudioClock(
  metrics: Record<string, number | null>,
): AudioClockAnalysis {
  const drift = typeof metrics.cumulativeDrift === "number" ? metrics.cumulativeDrift : null;
  if (drift === null) {
    return { clock: "unknown", drift: null, signature: "no-drift-data" };
  }
  if (Math.abs(drift) <= SYNTHETIC_DRIFT_THRESHOLD_MS) {
    return {
      clock: "synthetic",
      drift,
      signature: "drift-below-1e-6-ms",
    };
  }
  return { clock: "real", drift, signature: "drift-above-1e-6-ms" };
}