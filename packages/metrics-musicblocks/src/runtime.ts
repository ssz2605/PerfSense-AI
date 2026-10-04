import type { Page } from "playwright";
import { computeScheduleLag } from "./scheduleLag";

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
    const mb = (window).__mb;
    if (!mb || !mb.logo) return;

    // #7703 fallback counter.
    //
    // logo.js:1820-1856 is a three-way branch for every note delay. The
    // transport branch (1820-1840) calls logo.synth.transport.schedule when
    // the clock is available and running; the fallback branch (1841-1856)
    // schedules the same delay through logo._timerManager.setGuardedTimeout -
    // the setTimeout path that PR #7703 replaced. The transport branch gates on
    // isClockRunning, so a page whose audio clock is not running sends every
    // note delay down the fallback and the ratio reads 0; that is the same
    // number a revert produces, which is why the tripwire is baseline-relative.
    //
    // Wrapping the instance counts every guarded timer call, not just note
    // delays: logo.js also schedules unhighlights, its async yield and the
    // notation-export yield through setGuardedTimeout, and
    // embedded-graphics-scheduler.js calls it 17 times. The denominator is
    // therefore all guarded scheduling, and embedded-graphics-heavy projects
    // dilute the share. Reverting #7703 still moves the number (the numerator
    // falls to 0 while the denominator gains every note delay), which is what
    // the mutation proof relies on.
    if (!ps.fallbackLatched && mb.logo._timerManager &&
        typeof mb.logo._timerManager.setGuardedTimeout === 'function') {
      ps.fallbackLatched = true;
      ps.fallbackDelayCount = 0;
      const tm = mb.logo._timerManager;
      const origGuarded = tm.setGuardedTimeout.bind(tm);
      tm.setGuardedTimeout = function (cb, delay, guard) {
        ps.fallbackDelayCount = ps.fallbackDelayCount + 1;
        return origGuarded(cb, delay, guard);
      };
    }

    if (ps.transportLatched) return;
    if (!mb.logo.synth || !mb.logo.synth.transport) return;
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

/**
 * Counts and times `stage.update()` frames — the render axis that
 * `perfsense.config.json` had no metric for at all.
 *
 * Installed right after navigation (once `window.__mb.stage` exists) so it
 * spans the whole page lifetime, including project load. Frame start times are
 * kept as well as durations so a caller can restrict the sample to a window:
 * the load metric counts frames after `perfMarks.openStart`, and the interact
 * scenario restricts to its pan window.
 */
const RENDER_COLLECTOR_SNIPPET = `
  (function () {
    const ps = (window).__perfsense = (window).__perfsense || {};
    if (ps.renderLatched) return;
    const mb = (window).__mb;
    if (!mb || !mb.stage || typeof mb.stage.update !== 'function') return;
    ps.renderLatched = true;
    // frames: [startTimeMs, durationMs] pairs. calls: bare start times, kept
    // separately because the load metric only needs the count.
    ps.render = { frames: [], calls: [], windowStart: null, windowEnd: null };
    const origUpdate = mb.stage.update.bind(mb.stage);
    mb.stage.update = function () {
      const t0 = performance.now();
      origUpdate();
      const r = ps.render;
      r.frames.push([t0, performance.now() - t0]);
      r.calls.push(t0);
    };
  })();
`;

/** Waits for the benchmark bridge to expose the EaselJS stage. */
async function waitForStageBridge(
  page: Page,
  timeoutMs = 90000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    const ready = await page.evaluate(() => {
      const mb = (window as any).__mb;
      return !!(mb && mb.stage && typeof mb.stage.update === "function");
    });
    if (ready) return true;
    if (Date.now() - start > timeoutMs) return false;
    await page.waitForTimeout(250);
  }
}

/**
 * Waits for the benchmark bridge to expose a usable Logo engine.
 *
 * Readiness is `runFromBlockNow`, not `logo`: the collector wraps that one
 * method, so a `logo` that exists without it cannot be instrumented and waiting
 * for the stronger condition is the honest test.
 */
async function waitForLogoBridge(
  page: Page,
  timeoutMs = 90000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    const ready = await page.evaluate(() => {
      const mb = (window as any).__mb;
      return !!(
        mb &&
        mb.logo &&
        typeof mb.logo.runFromBlockNow === "function"
      );
    });
    if (ready) return true;
    if (Date.now() - start > timeoutMs) return false;
    await page.waitForTimeout(250);
  }
}

/** Counts block executions via runFromBlockNow (the engine's real per-block
 * path — queue pop/shift is deprecated in the modern app) and tracks nesting.
 * maxDepth keeps its original synchronous JS-nesting meaning. maxLogicalDepth
 * (experimental, excluded from the approved matrix) is the exact logical
 * action+flow depth per turtle at every executed block — mirrors
 * logicalDepth.ts in @perfsense/driver-playwright, inlined here so this
 * package stays dependency-free. */
const EXECUTION_COLLECTOR_SNIPPET = `
  (function () {
    const ps = (window).__perfsense = (window).__perfsense || {};
    if (ps.execLatched) return;
    const mb = (window).__mb;
    if (!mb || !mb.logo) return;
    if (typeof mb.logo.runFromBlockNow !== "function") return;
    // Built but not published: ps.exec/ps.execLatched are only set once the wrap
    // is actually in place. Publishing them first would make a failed wrap look
    // exactly like a latched collector that counted nothing, which is the same
    // silent-null hole as never installing at all.
    const exec = { blocksExecuted: 0, maxDepth: 0, depth: 0, maxLogicalDepth: 0 };
    try {
      const logo = mb.logo;
      const origRun = logo.runFromBlockNow.bind(logo);
      logo.runFromBlockNow = function (l, turtle, blk, isflow, receivedArg, queueStart) {
        exec.depth = exec.depth + 1;
        if (exec.depth > exec.maxDepth) exec.maxDepth = exec.depth;
        exec.blocksExecuted = exec.blocksExecuted + 1;
        // The engine passes a NUMERIC turtle index and resolves the turtle
        // itself via logo.turtles.ithTurtle() (logo.js:1938). Resolve the same
        // way so maxLogicalDepth reads the real turtle's queue + flow depths.
        try {
          if (logo.turtles && typeof logo.turtles.ithTurtle === "function") {
            const tur = logo.turtles.ithTurtle(turtle);
            if (tur != null) {
              const queued = Array.isArray(tur.queue) ? tur.queue.length : 0;
              const flow = Array.isArray(tur.parentFlowQueue)
                ? tur.parentFlowQueue.length
                : 0;
              if (queued + flow > exec.maxLogicalDepth) {
                exec.maxLogicalDepth = queued + flow;
              }
            }
          }
        } catch (e) {
          // Turtle may be mid-deletion; contribute depth 0 for this block.
          void e;
        }
        try {
          return origRun(l, turtle, blk, isflow, receivedArg, queueStart);
        } finally {
          exec.depth = exec.depth - 1;
        }
      };
      ps.exec = exec;
      ps.execLatched = true;
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
          Array.isArray(mb.turtles.turtleList) ? mb.turtles.turtleList :
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
export const RENDER_COLLECTOR = RENDER_COLLECTOR_SNIPPET;
export const EXECUTION_COLLECTOR = EXECUTION_COLLECTOR_SNIPPET;
export { runEndPollSnippet as RUN_END_POLL };

export async function installTransportCollector(page: Page): Promise<void> {
  // Wait for the bridge first. The snippet returns early when `mb.logo` is
  // absent and nothing ever retries it, so without this wait the collector
  // silently never latches and every seam metric reads null. It looked fine on
  // crabcanon-plot only because that page's approved set contains render
  // plugins, whose installer does wait and happens to run first; Frere-Jacques
  // has no render plugin, so transportEventRatio read null on all five runs.
  await waitForStageBridge(page);
  await page.evaluate(TRANSPORT_COLLECTOR_SNIPPET);
}

/**
 * Wraps `stage.update()` so frames can be counted and timed. Waits for the
 * bridge first: on the real app `window.__mb` only appears at the end of
 * activity init, seconds after the `load` event.
 */
export async function installRenderCollector(page: Page): Promise<boolean> {
  // Several plugins depend on this collector. It latches in the page, so the
  // cheap check first keeps a run from paying the bridge wait more than once.
  const already = await page.evaluate(
    () => !!(window as any).__perfsense && !!(window as any).__perfsense.render,
  );
  if (already) return true;
  const ready = await waitForStageBridge(page);
  if (!ready) return false;
  await page.evaluate(RENDER_COLLECTOR_SNIPPET);
  return page.evaluate(() => !!(window as any).__perfsense?.render);
}

/**
 * Wraps `logo.runFromBlockNow` so blocksExecuted and maxDepth can be read.
 *
 * Waits for the Logo bridge first. The snippet returns early when `mb.logo` is
 * absent and nothing ever retries it, so without this wait the collector
 * silently never installs — which is what made RainbowConnection produce no
 * maxDepth cell at all: its phases are openProject then saveExport, neither of
 * which installs an execution collector, and the plugin's setupPostNav runs
 * seconds before the real app creates `window.__mb` at the end of activity init.
 * `ps.exec` then stayed undefined and readPerfsense reported maxDepth as null on
 * every run.
 *
 * Throws when the wrapper is not in place. A caller that silently published the
 * null would turn a broken collector into a missing baseline cell, and a missing
 * cell is indistinguishable from a metric nobody watches.
 */
export async function installExecutionCollector(
  page: Page,
  timeoutMs = 90000,
): Promise<void> {
  const latched = await page.evaluate(
    () => !!(window as any).__perfsense && !!(window as any).__perfsense.exec,
  );
  if (latched) return;
  const ready = await waitForLogoBridge(page, timeoutMs);
  if (ready) await page.evaluate(EXECUTION_COLLECTOR_SNIPPET);
  const installed = await page.evaluate(
    () => !!(window as any).__perfsense?.exec,
  );
  if (!installed) {
    throw new Error(
      "execution collector did not install: window.__mb.logo never appeared " +
        "(or runFromBlockNow was not reachable), so blocksExecuted/maxDepth " +
        "cannot be measured on this page",
    );
  }
}

/**
 * Wraps `__mb.render.refreshCanvas` with a counter, so every refresh request the
 * app issues from then on is visible. PR #7923 suppressed the load-time flood of
 * these calls, so the healthy build records 0 here and that 0 is the whole point
 * of the cell.
 *
 * Because 0 is the healthy value, "latched and counted nothing" and "never
 * installed" must not be able to look alike. They are kept apart three ways:
 *
 *   1. `ps.refreshCanvasLatched` is set only by a successful wrap, and
 *      `ps.refreshCanvasCalls` is initialised in the same breath — so a latched
 *      page always has a number and a non-latched page never does.
 *   2. The install RETRIES. `__mb.stage` and `__mb.render` are created at
 *      different points of activity init, so a single attempt that found the
 *      stage but not the render object used to give up for good and leave the
 *      metric null on all five runs.
 *   3. readPerfsense maps "no latch" to null (never to 0) and reports the latch
 *      itself as `refreshCanvasWrapperLatched`, and this installer throws when
 *      the wrap never lands, so the run is discarded instead of published.
 */
export async function installRefreshCanvasCounter(
  page: Page,
  timeoutMs = 90000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = await waitForStageBridge(page, Math.min(5000, timeoutMs));
    if (ready) {
      const wrapped = await page.evaluate(() => {
        const ps = ((window as any).__perfsense =
          (window as any).__perfsense || {});
        if (ps.refreshCanvasLatched) return true;
        const mb = (window as any).__mb;
        if (!mb || !mb.render || typeof mb.render.refreshCanvas !== "function") {
          return false;
        }
        ps.refreshCanvasLatched = true;
        ps.refreshCanvasCalls = 0;
        const orig = mb.render.refreshCanvas.bind(mb.render);
        mb.render.refreshCanvas = function () {
          ps.refreshCanvasCalls = ps.refreshCanvasCalls + 1;
          return orig.apply(mb.render, arguments as any);
        };
        return true;
      });
      if (wrapped) return;
    }
    if (Date.now() > deadline) break;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `refreshCanvas counter did not install: window.__mb.render.refreshCanvas ` +
      `never appeared within ${timeoutMs}ms, so refreshCanvasCallCount cannot be ` +
      `distinguished from a healthy 0`,
  );
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
  const scheduleLagHelper = computeScheduleLag.toString();
  return page.evaluate((helperSrc: string) => {
    // Rehydrate the pure schedule-lag helper inside the page (same code
    // tested in Node under scheduleLag.test.ts).
    const computeScheduleLag: typeof import("./scheduleLag").computeScheduleLag =
      new Function("return (" + helperSrc + ")")();
    const ps = (window as any).__perfsense || {};
    const t = ps.transport || null;
    const out: Record<string, number | null> = {
      callbackLatencyMean: null,
      callbackLatencyMax: null,
      cumulativeDrift: null,
      voiceOnsetError: null,
      transportEventRatio: null,
      blocksExecuted: null,
      maxDepth: null,
      maxLogicalDepth: null,
      scheduleCount: null,
      executionTime: null,
      maxQueueDepth: null,
      projectLoadTime: null,
      saveTime: null,
      exportMIDITime: null,
      saveAsLilypondTime: null,
      peakHeapDuringExport: null,
      bootstrapTotal: null,
      initTotal: null,
      heapAfterBoot: null,
      memoryDelta: null,
      retainedHeap: null,
      retainedHeapSlope: null,
      repeatRuns: null,
      canvasInkCoverage: null,
      canvasInkDrift: null,
      synthsRetained: null,
      logoSoundsRetained: null,
      stageUpdateTime: null,
      stageUpdateMax: null,
      stageUpdateFrameCount: null,
      stageUpdateCallCount: null,
      cacheRebuildCount: null,
      viewportCulledBlocks: null,
      transportEventCount: null,
      cacheSkippedCount: null,
      viewportCulledFraction: null,
      refreshCanvasCallCount: null,
      // 1 when the refreshCanvas wrapper is actually in the page, 0 when it is
      // not. Distinct from refreshCanvasCallCount, whose healthy value IS 0.
      refreshCanvasWrapperLatched: null,
      panSteps: null,
    };
    const mean = (arr: number[]) =>
      arr.length === 0 ? null : arr.reduce((s, v) => s + v, 0) / arr.length;
    if (t) {
      out.callbackLatencyMean = mean(t.latencies);
      out.callbackLatencyMax =
        t.latencies.length === 0 ? null : Math.max(...t.latencies);
      out.transportEventCount = typeof t.count === "number" ? t.count : null;
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
      out.scheduleCount = typeof t.count === "number" ? t.count : null;
      const lag = computeScheduleLag(t.scheduledTx, t.firedAudio);
      out.scheduleLagMean = lag.mean;
      out.scheduleLagMax = lag.max;
    }
    // transportEventRatio: share of note delays that went through
    // Tone.Transport rather than the setTimeout fallback (logo.js:1841-1856).
    // 1.0 means every delay used the transport seam. Null when either counter
    // is unavailable, so a missing seam reads as "no data", never as healthy.
    if (
      ps.transport &&
      typeof ps.transport.count === "number" &&
      typeof ps.fallbackDelayCount === "number"
    ) {
      const viaTransport = ps.transport.count;
      const viaFallback = ps.fallbackDelayCount;
      out.transportEventRatio =
        viaTransport + viaFallback === 0
          ? null
          : viaTransport / (viaTransport + viaFallback);
    }

    // #7923: refreshCanvas() calls across the whole run. Reverting the
    // _suppressRefresh guard makes the load repaint, so this counter spikes; the
    // healthy build records 0, because suppressing the repaint is the
    // optimization. A wrapper that never installed must therefore read as null
    // (no data) and never as 0 — 0 here means "latched and nothing was
    // requested", which is a real, healthy observation.
    //
    // Deliberately NOT inside the `ps.render` branch below: this counter has its
    // own installer and its own page-side state. RainbowConnection approves it
    // without approving a single render-collector plugin, so gating the read on
    // ps.render would report null on exactly the fixture that needs the cell.
    out.refreshCanvasCallCount =
      ps.refreshCanvasLatched === true &&
      typeof ps.refreshCanvasCalls === "number"
        ? ps.refreshCanvasCalls
        : null;
    out.refreshCanvasWrapperLatched = ps.refreshCanvasLatched === true ? 1 : 0;

    // Render axis. Frames are [startMs, durationMs] pairs; windowStart/windowEnd
    // delimit the interact scenario's pan so idle frames outside it never dilute
    // the sample.
    const render = ps.render;
    if (render) {
      const wStart =
        typeof render.windowStart === "number" ? render.windowStart : null;
      const wEnd =
        typeof render.windowEnd === "number" ? render.windowEnd : null;
      const all: number[][] = Array.isArray(render.frames) ? render.frames : [];
      const inWindow =
        wStart === null || wEnd === null
          ? []
          : all.filter(
              (f) => Array.isArray(f) && f[0] >= wStart && f[0] <= wEnd,
            );
      const durations = inWindow.map((f) => f[1]);
      out.stageUpdateTime = mean(durations);
      out.stageUpdateMax =
        durations.length === 0 ? null : Math.max.apply(null, durations);
      out.stageUpdateFrameCount = durations.length;
      // Pan bookkeeping written by the interact scenario.
      out.cacheRebuildCount =
        typeof render.cacheRebuildCount === "number"
          ? render.cacheRebuildCount
          : null;
      out.viewportCulledBlocks =
        typeof render.viewportCulledBlocks === "number"
          ? render.viewportCulledBlocks
          : null;
      out.cacheSkippedCount =
        typeof render.cacheSkippedCount === "number"
          ? render.cacheSkippedCount
          : null;
      out.panSteps =
        typeof render.panSteps === "number" ? render.panSteps : null;
      // #7738 in fraction form: how much of the workspace the culler hid at
      // peak, out of every block on the canvas. Same Deterministic pan, so
      // the healthy build records the same numerator and denominator.
      const culledPeak = out.viewportCulledBlocks;
      const blockTotal =
        typeof render.blockTotal === "number" ? render.blockTotal : null;
      out.viewportCulledFraction =
        culledPeak !== null && blockTotal !== null && blockTotal > 0
          ? culledPeak / blockTotal
          : null;
      // #7923: how many stage.update() frames the load actually painted. With
      // _suppressRefresh set (js/activity.js:2152-2159) refreshCanvas() returns
      // early, stageDirty is never set during decode, and the render loop goes
      // idle — so this collapses. Counting from perfMarks.openStart makes it
      // independent of frames painted before the fixture was dropped.
      const mbBridge = (window as any).__mb || {};
      const openStart =
        mbBridge.perfMarks && typeof mbBridge.perfMarks.openStart === "number"
          ? mbBridge.perfMarks.openStart
          : null;
      const calls: number[] = Array.isArray(render.calls) ? render.calls : [];
      out.stageUpdateCallCount =
        openStart === null ? null : calls.filter((t) => t >= openStart).length;
    }
    if (ps.exec) {
      out.blocksExecuted = ps.exec.blocksExecuted;
      out.maxDepth = ps.exec.maxDepth === 0 ? null : ps.exec.maxDepth;
      out.maxLogicalDepth =
        ps.exec.maxLogicalDepth === 0 ? null : ps.exec.maxLogicalDepth;
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
    if (typeof ps.saveAsLilypondTime === "number")
      out.saveAsLilypondTime = ps.saveAsLilypondTime;
    if (typeof ps.bootstrapTotal === "number")
      out.bootstrapTotal = ps.bootstrapTotal;
    if (typeof ps.initTotal === "number") out.initTotal = ps.initTotal;
    if (typeof ps.heapAfterBoot === "number")
      out.heapAfterBoot = ps.heapAfterBoot;
    if (typeof ps.memoryDelta === "number") out.memoryDelta = ps.memoryDelta;
    if (typeof ps.retainedHeap === "number") out.retainedHeap = ps.retainedHeap;

    // Natural-completion lifecycle (#7832 / #7848). Written by the
    // playToCompletion and repeatedRun scenarios, never by product code.
    if (typeof ps.synthsRetained === "number")
      out.synthsRetained = ps.synthsRetained;
    if (typeof ps.logoSoundsRetained === "number")
      out.logoSoundsRetained = ps.logoSoundsRetained;

    // Canvas accumulation across repeated runs (#7848). inkCoverage is the mean
    // coverage across runs, inkDrift is (last - first): the invariant "a natural
    // completion preserves the drawing and never accumulates" reads as
    // inkDrift ~= 0.
    if (typeof ps.canvasInkCoverage === "number")
      out.canvasInkCoverage = ps.canvasInkCoverage;
    if (typeof ps.canvasInkDrift === "number")
      out.canvasInkDrift = ps.canvasInkDrift;
    if (typeof ps.repeatRuns === "number") out.repeatRuns = ps.repeatRuns;
    if (typeof ps.retainedHeapSlope === "number")
      out.retainedHeapSlope = ps.retainedHeapSlope;

    // Export peak heap (#7970's documented memory cost).
    if (typeof ps.peakHeapDuringExport === "number")
      out.peakHeapDuringExport = ps.peakHeapDuringExport;
    return out;
  }, scheduleLagHelper);
}
