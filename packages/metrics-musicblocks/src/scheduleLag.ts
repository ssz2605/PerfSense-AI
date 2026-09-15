/**
 * Pure computation of per-event audio-timeline scheduling lag.
 *
 * scheduleLag measures how far each successive audio firing drifted from its
 * requested schedule interval — NOT wall-clock callback latency:
 *
 *   expected = (scheduledTx[i] - scheduledTx[i-1]) * 1000   ms (transport time)
 *   actual   = (firedAudio[i] - firedAudio[i-1]) * 1000     ms (audio-context time)
 *   lag      = |actual - expected|                          ms (per event)
 *
 * The inputs come from the PR #7703 scheduler seam: `scheduledTx` is the tone
 * transport time requested for each event and `firedAudio` is the audio-context
 * time Tone fired it at.
 *
 * Why this is distinct from callback latency:
 *   - callbackLatencyMean/Max compare WALL-CLOCK times (schedule() call vs
 *     callback fire). A busy main thread inflates callback latency while the
 *     audio clock stays aligned, leaving scheduleLag at ~0.
 *   - scheduleLag compares AUDIO-CLOCK intervals. Audio-clock jitter inflates
 *     scheduleLag while wall-clock latency stays flat.
 *   - cumulativeDrift is the SUM of the same per-event deviations over a run;
 *     scheduleLagMean/Max aggregate them per event (mean / worst case) so a
 *     long run with a few staggered events is not swamped by the count.
 *
 * scheduleLagMean/Max are reset with the transport arrays per run (the seam
 * recreates `ps.transport` whenever a new run starts).
 */
export interface ScheduleLagResult {
  mean: number | null;
  max: number | null;
}

export function computeScheduleLag(
  scheduledTx: Array<number | null>,
  firedAudio: Array<number | null>,
): ScheduleLagResult {
  let sum = 0;
  let max = 0;
  let count = 0;
  for (let i = 1; i < scheduledTx.length; i++) {
    const sPrev = scheduledTx[i - 1];
    const sCur = scheduledTx[i];
    const aPrev = firedAudio[i - 1];
    const aCur = firedAudio[i];
    if (sPrev === null || sCur === null || aPrev === null || aCur === null) {
      continue;
    }
    const expectedMs = (sCur - sPrev) * 1000;
    const actualMs = (aCur - aPrev) * 1000;
    const lag = Math.abs(actualMs - expectedMs);
    sum += lag;
    count++;
    if (lag > max) max = lag;
  }
  if (count === 0) return { mean: null, max: null };
  return { mean: sum / count, max };
}