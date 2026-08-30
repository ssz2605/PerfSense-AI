import type { Page } from "playwright";

/**
 * Page-side instrumentation for the real Music Blocks app.
 *
 * All snippets run inside the benchmarked page and rely on the guarded
 * `window.__mb` benchmark bridge exposed by the app (no-op outside
 * benchmarks). Instrumentation is idempotent per run and accumulates into
 * `window.__perfsense` for the thin metric plugins to read.
 */

/**
 * Wraps the PR #7703 scheduler seam `logo.synth.transport.schedule()`.
 *
 * Every scheduled playback event records:
 *   - schedule() wall-clock time and the tone transport time requested
 *   - the callback wall-clock time and the audio-context time Tone fired
 *
 * From these, the migration's headline guarantees can be regressed directly:
 * callback latency (mean / max), cumulative synchronization drift, and
 * voice-onset error (latency of the first scheduled event after a run).
 */
const TRANSPORT_COLLECTOR_SNIPPET = `
  (function () {
    const ps = (window).__perfsense = (window).__perfsense || {};
    if (ps.transportLatched) return;
    const mb = (window).__mb;
    if (!mb || !mb.logo || !mb.logo.synth || !mb.logo.synth.transport) return;
    const transport = mb.logo.synth.transport;
    if (typeof transport.schedule !== 'function') return;
    ps.transportLatched = true;
    ps.transport = { latencies: [], scheduledTx: [], firedAudio: [], onset: null, count: 0 };
    const origSchedule = transport.schedule.bind(transport);
    transport.schedule = function (cb, time) {
      const scheduleWall = performance.now();
      const id = origSchedule(function (audioContextTime) {
        const firedWall = performance.now();
        const t = ps.transport;
        t.latencies.push(firedWall - scheduleWall);
        t.scheduledTx.push(typeof time === 'number' ? time : null);
        t.firedAudio.push(typeof audioContextTime === 'number' ? audioContextTime : null);
        t.count = t.count + 1;
        if (t.onset === null) t.onset = firedWall - scheduleWall;
        if (typeof cb === 'function') cb(audioContextTime);
      }, time);
      return id;
    };
  })();
`;

/** Counts block executions via runFromBlockNow (the engine's real per-block
 * path — queue pop/shift is deprecated in the modern app) and tracks nesting. */
const EXECUTION_COLLECTOR_SNIPPET = `
  (function () {
    const ps = (window).__perfsense = (window).__perfsense || {};
    if (ps.execLatched) return;
    const mb = (window).__mb;
    if (!mb || !mb.logo) return;
    ps.execLatched = true;
    ps.exec = { blocksExecuted: 0, maxDepth: 0, depth: 0 };
    try {
      const logo = mb.logo;
      const origRun = logo.runFromBlockNow.bind(logo);
      logo.runFromBlockNow = function (l, turtle, blk, isflow, receivedArg, queueStart) {
        const exec = ps.exec;
        exec.depth = exec.depth + 1;
        if (exec.depth > exec.maxDepth) exec.maxDepth = exec.depth;
        exec.blocksExecuted = exec.blocksExecuted + 1;
        try {
          return origRun(l, turtle, blk, isflow, receivedArg, queueStart);
        } finally {
          exec.depth = exec.depth - 1;
        }
      };
    } catch (e) {
      void e;
    }
  })();
`;

/** Polls until the app reports the run has finished, then a settle pause. */
function runEndPollSnippet(timeoutMs: number, settleMs: number): string {
  return `
  (async function () {
    const ps = (window).__perfsense = (window).__perfsense || {};
    const mb = (window).__mb;
    const startMs = Date.now();
    const timeoutMs = ${timeoutMs};
    const settleMs = ${settleMs};
    const isRunning = () => {
      const psRun = (window).__perfsense ? (window).__perfsense : null;
      if (psRun && psRun.transport && psRun.transport.pending > 0) return true;
      if (mb && mb.runner && typeof mb.runner.isRunning === 'function') {
        return mb.runner.isRunning();
      }
      if (mb && mb.logo && typeof mb.logo.isRunning === 'function') {
        return mb.logo.isRunning();
      }
      // Fallback: turtles with non-empty queues mean work is pending.
      if (mb && mb.turtles) {
        const list =
          Array.isArray(mb.turtles) ? mb.turtles :
          Array.isArray(mb.turtles.turtles) ? mb.turtles.turtles : [];
        for (let i = 0; i < list.length; i++) {
          if (list[i] && Array.isArray(list[i].queue) && list[i].queue.length > 0) return true;
        }
      }
      return false;
    };
    const poll = async () => {
      for (;;) {
        if (!isRunning()) break;
        if (Date.now() - startMs > timeoutMs) break;
        await new Promise((r) => setTimeout(r, 150));
      }
    };
    await poll();
    const doneAt = performance.now();
    await new Promise((r) => setTimeout(r, settleMs));
    return doneAt;
  })()
`;
}

export const TRANSPORT_COLLECTOR = TRANSPORT_COLLECTOR_SNIPPET;
export const EXECUTION_COLLECTOR = EXECUTION_COLLECTOR_SNIPPET;
export { runEndPollSnippet as RUN_END_POLL };

export async function installTransportCollector(page: Page): Promise<void> {
  await page.evaluate(TRANSPORT_COLLECTOR_SNIPPET);
}

export async function installExecutionCollector(page: Page): Promise<void> {
  await page.evaluate(EXECUTION_COLLECTOR_SNIPPET);
}

export async function waitForRunEnd(
  page: Page,
  timeoutMs = 120000,
): Promise<void> {
  await page.evaluate(runEndPollSnippet(timeoutMs, 1200));
}

export async function readPerfsense(
  page: Page,
): Promise<Record<string, number | null>> {
  return page.evaluate(() => {
    const ps = (window as any).__perfsense || {};
    const t = ps.transport || null;
    const out: Record<string, number | null> = {
      callbackLatencyMean: null,
      callbackLatencyMax: null,
      cumulativeDrift: null,
      voiceOnsetError: null,
      blocksExecuted: null,
      maxDepth: null,
      executionTime: null,
      maxQueueDepth: null,
      projectLoadTime: null,
      saveTime: null,
      exportMIDITime: null,
      bootstrapTotal: null,
      initTotal: null,
      heapAfterBoot: null,
      memoryDelta: null,
      retainedHeap: null,
    };
    const mean = (arr: number[]) =>
      arr.length === 0 ? null : arr.reduce((s, v) => s + v, 0) / arr.length;
    if (t) {
      out.callbackLatencyMean = mean(t.latencies);
      out.callbackLatencyMax =
        t.latencies.length === 0 ? null : Math.max(...t.latencies);
      let drift = 0;
      for (let i = 1; i < t.scheduledTx.length; i++) {
        const ds =
          t.scheduledTx[i - 1] !== null && t.scheduledTx[i] !== null
            ? t.scheduledTx[i] - t.scheduledTx[i - 1]
            : null;
        const da =
          t.firedAudio[i - 1] !== null && t.firedAudio[i] !== null
            ? t.firedAudio[i] - t.firedAudio[i - 1]
            : null;
        if (ds !== null && da !== null) {
          drift += Math.abs(da * 1000 - ds * 1000);
        }
      }
      out.cumulativeDrift = drift;
      out.voiceOnsetError = t.onset;
    }
    if (ps.exec) {
      out.blocksExecuted = ps.exec.blocksExecuted;
      out.maxDepth = ps.exec.maxDepth === 0 ? null : ps.exec.maxDepth;
    }
    if (typeof ps.executionTime === "number")
      out.executionTime = ps.executionTime;
    if (typeof ps.maxQueueDepth === "number")
      out.maxQueueDepth = ps.maxQueueDepth;
    if (typeof ps.projectLoadTime === "number")
      out.projectLoadTime = ps.projectLoadTime;
    if (typeof ps.saveTime === "number") out.saveTime = ps.saveTime;
    if (typeof ps.exportMIDITime === "number")
      out.exportMIDITime = ps.exportMIDITime;
    if (typeof ps.bootstrapTotal === "number")
      out.bootstrapTotal = ps.bootstrapTotal;
    if (typeof ps.initTotal === "number") out.initTotal = ps.initTotal;
    if (typeof ps.heapAfterBoot === "number")
      out.heapAfterBoot = ps.heapAfterBoot;
    if (typeof ps.memoryDelta === "number") out.memoryDelta = ps.memoryDelta;
    if (typeof ps.retainedHeap === "number") out.retainedHeap = ps.retainedHeap;
    return out;
  });
}
