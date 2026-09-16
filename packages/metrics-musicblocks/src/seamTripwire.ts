/**
 * #7703 seam tripwire (Layer A) — deterministic, clock-independent.
 *
 * The Tone.Transport scheduling seam is the whole basis of the Frère Jacques
 * audio metrics. If playback scheduling were ever reverted to setTimeout, the
 * transport collector records zero scheduled events and all four audio metrics
 * come back null. This check turns "no data" into an explicit finding rather
 * than an empty row.
 *
 * Intentionally standalone: it performs no statistical comparison, touches no
 * approved metric semantics, and is not wired into the report/statistical path
 * yet. It is the unit-tested building block for the future gate.
 */

export const FRERE_JACQUES_TRANSPORT_METRICS = [
  "callbackLatencyMean",
  "callbackLatencyMax",
  "cumulativeDrift",
  "voiceOnsetError",
] as const;

export interface TransportSeamCheck {
  alive: boolean;
  /** transport.schedule events that fired, when the collector reported them. */
  scheduledEvents: number | null;
  reason?: string;
}

export function checkTransportSeamAlive(
  metrics: Record<string, number | null>,
): TransportSeamCheck {
  const scheduledEvents =
    typeof metrics.scheduleCount === "number" ? metrics.scheduleCount : null;
  const observations = FRERE_JACQUES_TRANSPORT_METRICS.filter(
    (m) => typeof metrics[m] === "number",
  ).length;

  if (scheduledEvents !== null && scheduledEvents > 0) {
    return { alive: true, scheduledEvents };
  }
  if (observations > 0) {
    return { alive: true, scheduledEvents };
  }
  return {
    alive: false,
    scheduledEvents,
    reason:
      "no transport.schedule events observed (scheduleCount is null or 0 and all audio metrics are null); the Tone.Transport seam may be dead, e.g. playback scheduling reverted to setTimeout",
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