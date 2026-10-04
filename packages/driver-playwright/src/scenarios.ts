import type { Page } from "playwright";
import { LOGICAL_DEPTH_HELPER_SRC } from "./logicalDepth";

/**
 * Per-page interaction scenarios that turn a real Music Blocks page into a
 * measurable workload. Scenarios run inside the benchmarked page and write
 * their observations into `window.__perfsense`; the thin metric plugins in
 * `@perfsense/metrics-musicblocks` read those values.
 *
 * Every scenario is self-sufficient: it installs the transport / execution
 * collectors it needs (the collectors latch, so installing them again later is
 * a no-op) and feature-detects the benchmark bridge so it degrades to null
 * metrics on pages that do not expose the seams.
 */

export const Scenario = {
  Bootstrap: "bootstrap",
  OpenProject: "openProject",
  PlayToCompletion: "playToCompletion",
  SaveExport: "saveExport",
  Interact: "interact",
  RepeatedRun: "repeatedRun",
} as const;

export type ScenarioName = (typeof Scenario)[keyof typeof Scenario];

export interface ScenarioOptions {
  fixtureName?: string;
  timeoutMs?: number;
  settleMs?: number;
  panSteps?: number;
  panSettleMs?: number;
  repeatRuns?: number;
}

export const SCENARIOS: readonly ScenarioName[] = [
  Scenario.Bootstrap,
  Scenario.OpenProject,
  Scenario.PlayToCompletion,
  Scenario.SaveExport,
  Scenario.Interact,
  Scenario.RepeatedRun,
];

/** Defaults for the interact / repeatedRun phases. */
export const INTERACT_DEFAULTS = { panSteps: 24, panSettleMs: 120 };
// 10 in-page runs, not 20. Each run is a full play-to-completion of the
// fixture, so this is the dominant cost of the repeatedRun phase; 10 still
// gives the least-squares retainedHeapSlope enough points to be meaningful
// while halving the phase.
export const REPEATED_RUN_DEFAULTS = { repeatRuns: 10 };

const bootstrapSnippet = `
(async function (__opt) {
  const ps = (window).__perfsense = (window).__perfsense || {};
  const timeoutMs = __opt.timeoutMs || 120000;
  const startMs = Date.now();
  // Wait for the app's bootstrap marks to actually land. window.__mbPerf exists
  // from the first line of the loader, so its mere presence is NOT a ready
  // signal — and neither is the first loader-stage measure, which lands several
  // seconds before the activity-init measures this metric reads. Wait until one
  // of the alias-target keys below is numeric, so the pick below finds a value
  // on the real app (bootstrapTotal <- loader_to_activity_init_complete).
  const bootKeys = ['bootstrapTotal', 'bootTime', 'loader.total_bootstrap',
    'loader_to_activity_init_complete', 'bootstrapStart', 'bootstrapEnd'];
  const initKeys = ['initTotal', 'activity.init_total'];
  for (;;) {
    const m = (window).__mbPerf && (window).__mbPerf.measures ? (window).__mbPerf.measures : {};
    const bootReady = bootKeys.some((k) => typeof m[k] === 'number');
    const initReady = initKeys.some((k) => typeof m[k] === 'number');
    if (bootReady && initReady) break;
    if (Date.now() - startMs > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const perf = (window).__mbPerf && typeof (window).__mbPerf === 'object' ? (window).__mbPerf : {};
  const measures = (perf.measures && typeof perf.measures === 'object') ? perf.measures : perf;
  const pick = (keys) => {
    for (let i = 0; i < keys.length; i++) {
      if (typeof measures[keys[i]] === 'number') return measures[keys[i]];
      if (typeof perf[keys[i]] === 'number') return perf[keys[i]];
      if (typeof (window).__perfsense[keys[i]] === 'number') return (window).__perfsense[keys[i]];
    }
    return null;
  };
  if (typeof ps.bootstrapTotal !== 'number') {
    const s = pick(['bootstrapStart']); const e = pick(['bootstrapEnd']);
    ps.bootstrapTotal = (s !== null && e !== null && e > s) ? (e - s) : pick(['bootstrapTotal', 'bootTime', 'loader_to_activity_init_complete', 'loader.total_bootstrap']);
  }
  if (typeof ps.initTotal !== 'number') {
    ps.initTotal = pick(['initTotal', 'setupDependenciesTotal', 'initTime', 'activity.init_total']);
  }
  if (typeof ps.heapAfterBoot !== 'number') {
    const mem = (window).performance.memory;
    ps.heapAfterBoot = (typeof mem === 'undefined') ? null : mem.usedJSHeapSize;
  }
  return {
    bootstrapTotal: ps.bootstrapTotal,
    initTotal: ps.initTotal,
    heapAfterBoot: ps.heapAfterBoot,
    measuresKeys: Object.keys(perf).slice(0, 20)
  };
})
`;

/**
 * Page-evaluated readiness probe for the open-project phase.
 *
 * Exported so the stability rule can be exercised directly: it is the only
 * signal that a staged load has actually finished, and a rule this load-bearing
 * should not be verified only by a 40-minute CI run.
 */
export const openProjectSnippet = `
(async function (__opt) {
  const ps = (window).__perfsense = (window).__perfsense || {};
  const timeoutMs = __opt.timeoutMs || 120000;
  const startMs = Date.now();
  const openStart = performance.now();
  const bridgeMark = (() => {
    const mb = (window).__mb || {};
    return (mb.perfMarks && typeof mb.perfMarks.openStart === 'number') ? mb.perfMarks.openStart : null;
  })();
  // "Render ready" means the workspace stopped growing (and differs from the
  // boot-time baseline, which is non-empty by default in the real app). On the
  // real app blocks render to the canvas, so count blocks.blockList rather than
  // DOM ".block" nodes; mocks without that surface fall back to the DOM count.
  // window.__mb is read live every sample: it may not exist yet at scenario
  // start on cold pages.
  const blockCount = () => {
    const mb = (window).__mb || {};
    if (mb.blocks && Array.isArray(mb.blocks.blockList)) return mb.blocks.blockList.length;
    return (document.querySelectorAll('#blockTable .block, .blockTable .block, #blocks .block')).length;
  };
  const initialLen = blockCount();
  // A project this size is decoded in stages, and the block count sits still
  // between two of them. Two equal samples cannot tell that lull from the end
  // of the load. On RainbowConnection it ended the wait mid-decode on roughly
  // half the runs, which reported projectLoadTime ~20% short and then handed
  // the still-busy app to the export phase, whose timing moved the opposite
  // way; the pair measured bimodal on every capture. Hold the count steady
  // across STABLE_SAMPLES polls instead, long enough to outlast a lull between
  // stages, so "ready" means finished rather than momentarily quiet.
  const STABLE_POLL_MS = 400;
  const STABLE_SAMPLES = 7;
  const waitStable = async () => {
    let prev = -1;
    let rounds = 0;
    for (;;) {
      if (Date.now() - startMs > timeoutMs) return false;
      const cur = blockCount();
      if (cur === prev && cur > 0 && cur !== initialLen) {
        rounds += 1;
        if (rounds >= STABLE_SAMPLES) return true;
      } else {
        rounds = 0;
      }
      prev = cur;
      await new Promise((r) => setTimeout(r, STABLE_POLL_MS));
    }
  };
  let ready = await waitStable();
  if (!ready) {
    // No renderable block table (e.g. minimal mocks): fall back to the bridge's
    // ready flag, then settle so the app finishes any async decode.
    for (;;) {
      const mb = (window).__mb || {};
      const bridgeLoaded = mb.blocks && typeof mb.blocks.projectLoaded === 'function' && mb.blocks.projectLoaded();
      if (bridgeLoaded || Date.now() - startMs > timeoutMs) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const openEnd = performance.now();
  const elapsed = bridgeMark !== null ? (openEnd - bridgeMark) : (openEnd - openStart);
  ps.projectLoadTime = (typeof elapsed === 'number' && elapsed >= 0) ? elapsed : null;
  ps._projectOpened = true;
  return { projectLoadTime: ps.projectLoadTime, fixture: __opt.fixtureName || null };
})
`;

const saveExportSnippet = `
(async function (__opt) {
  const ps = (window).__perfsense = (window).__perfsense || {};
  const timeoutMs = __opt.timeoutMs || 120000;
  const startMs = Date.now();
  const mb = (window).__mb || {};
  const clickById = (ids) => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) { el.click(); return true; }
    }
    return false;
  };
  // PR #7970 traded ~20x peak memory for the export speedup, so the export
  // phases sample the heap while they run. No forced GC here on purpose: gc()
  // every 100ms would distort the very timings this phase is measuring. Peak
  // detection does not need one -- --enable-precise-memory-info keeps
  // usedJSHeapSize live between collections.
  let peak = 0;
  let sampling = true;
  const sampler = setInterval(() => {
    if (!sampling) return;
    const v = typeof performance.memory === 'undefined' ? 0 : performance.memory.usedJSHeapSize;
    if (typeof v === 'number' && v > peak) peak = v;
  }, 100);
  try {
    if (typeof ps.saveTime !== 'number') {
      const hasUiSave = mb.ui && typeof mb.ui.save === 'function';
      if (hasUiSave) {
        const t0 = performance.now();
        try { await mb.ui.save(); } catch (e) { void e; }
        ps.saveTime = performance.now() - t0;
      } else {
        clickById(['saveTop', 'save', 'saveTopSave']);
        ps.saveTime = null;
      }
    }
    if (typeof ps.exportMIDITime !== 'number') {
      const hasUiExport = mb.ui && typeof mb.ui.exportMIDI === 'function';
      if (hasUiExport) {
        const t0 = performance.now();
        try { await mb.ui.exportMIDI(); } catch (e) { void e; }
        ps.exportMIDITime = performance.now() - t0;
      } else {
        clickById(['exportMIDI', 'export', 'export-midi']);
        ps.exportMIDITime = null;
      }
    }
    if (typeof ps.saveAsLilypondTime !== 'number') {
      const hasUiLilypond = mb.ui && typeof mb.ui.saveAsLilypond === 'function';
      if (hasUiLilypond) {
        const t0 = performance.now();
        try { await mb.ui.saveAsLilypond(); } catch (e) { void e; }
        ps.saveAsLilypondTime = performance.now() - t0;
      } else {
        clickById(['submitLilypond', 'saveLilypond']);
        ps.saveAsLilypondTime = null;
      }
    }
  } finally {
    sampling = false;
    clearInterval(sampler);
  }
  ps.peakHeapDuringExport = peak > 0 ? peak : null;
  void startMs; void timeoutMs;
  return {
    saveTime: ps.saveTime,
    exportMIDITime: ps.exportMIDITime,
    saveAsLilypondTime: ps.saveAsLilypondTime,
    peakHeapDuringExport: ps.peakHeapDuringExport
  };
})
`;

const playToCompletionSnippet = `
(async function (__opt) {
  const ps = (window).__perfsense = (window).__perfsense || {};
  const timeoutMs = __opt.timeoutMs || 120000;
  const settleMs = __opt.settleMs || 1000;
  const mb = (window).__mb || {};

  // --- install transport seam (idempotent) ---
  if (!ps.transportLatched && mb.logo && mb.logo.synth && mb.logo.synth.transport &&
      typeof mb.logo.synth.transport.schedule === 'function') {
    const transport = mb.logo.synth.transport;
    const origSchedule = transport.schedule.bind(transport);
    ps.transportLatched = true;
    ps.transport = { latencies: [], scheduledTx: [], firedAudio: [], onset: null, count: 0, pending: 0 };
    transport.schedule = function (cb, time) {
      const scheduleWall = performance.now();
      const t = ps.transport;
      t.pending = t.pending + 1;
      return origSchedule(function (audioContextTime) {
        const firedWall = performance.now();
        t.pending = Math.max(0, t.pending - 1);
        t.latencies.push(firedWall - scheduleWall);
        t.scheduledTx.push(typeof time === 'number' ? time : null);
        t.firedAudio.push(typeof audioContextTime === 'number' ? audioContextTime : null);
        t.count = t.count + 1;
        if (t.onset === null) t.onset = firedWall - scheduleWall;
        if (typeof cb === 'function') cb(audioContextTime);
      }, time);
    };
    if (typeof transport.cancel === 'function') {
      const origCancel = transport.cancel.bind(transport);
      transport.cancel = function () {
        ps.transport.pending = 0;
        return origCancel.apply(this, arguments);
      };
    }
  }

  // --- install execution collector (idempotent) ---
  // The modern engine executes through runFromBlockNow, not deprecated queue
  // pop/shift, so blocksExecuted counts that entry point and maxDepth its
  // JS nesting. maxLogicalDepth (experimental, not in the approved matrix) is
  // the exact logical action+flow depth per turtle at every executed block:
  // the engine runs flow recursion iteratively through queue +
  // parentFlowQueue, so that sum IS the program-level nesting depth
  // (see logicalDepth.ts, unit-tested).
  if (!ps.execLatched && mb.logo) {
    ps.execLatched = true;
    ps.exec = { blocksExecuted: 0, maxDepth: 0, depth: 0, maxLogicalDepth: 0 };
    const logo = mb.logo;
    const __logicalDepthOf = ${LOGICAL_DEPTH_HELPER_SRC};
    const origRun = logo.runFromBlockNow.bind(logo);
    logo.runFromBlockNow = function () {
      const exec = ps.exec;
      exec.depth = exec.depth + 1;
      if (exec.depth > exec.maxDepth) exec.maxDepth = exec.depth;
      // The engine receives a NUMERIC turtle index and resolves the turtle
      // itself via logo.turtles.ithTurtle() (logo.js:1938) — so resolve the
      // same way here; otherwise queue/parentFlowQueue never resolve and the
      // logical depth always reads 0.
      let ld = 0;
      try {
        if (logo.turtles && typeof logo.turtles.ithTurtle === "function") {
          ld = __logicalDepthOf(logo.turtles.ithTurtle(arguments[1]));
        }
      } catch (e) {
        // Turtle may be mid-deletion; contribute depth 0 for this block.
        void e;
      }
      if (ld > exec.maxLogicalDepth) exec.maxLogicalDepth = ld;
      exec.blocksExecuted = exec.blocksExecuted + 1;
      try { return origRun.apply(logo, arguments); } finally { exec.depth = exec.depth - 1; }
    };
  }

  // Resolve the real turtle array. window.__mb.turtles is the Turtles
  // container, whose array lives behind the turtleList getter; reading
  // .turtles (a legacy name that does not exist on the container) made the
  // pending-work check and the queue sampler see an empty list, so
  // maxQueueDepth stayed ~0 on real runs.
  const turtleArray = () => {
    if (Array.isArray(mb.turtles)) return mb.turtles;
    if (mb.turtles && Array.isArray(mb.turtles.turtleList)) return mb.turtles.turtleList;
    if (mb.turtles && Array.isArray(mb.turtles.turtles)) return mb.turtles.turtles;
    return [];
  };

  const isRunning = () => {
    if (mb.runner && typeof mb.runner.isRunning === 'function' && mb.runner.isRunning()) return true;
    if (mb.turtles && typeof mb.turtles.running === 'function' && mb.turtles.running()) return true;
    // Scheduled-but-unfired transport events mean playback is still pending:
    // the flat block-stepping loop ends long before the last scheduled note
    // fires. Without this, waitDone returns after the sync segment only.
    if (ps.transport && ps.transport.pending > 0) return true;
    if (mb.logo && typeof mb.logo.isRunning === 'function' && mb.logo.isRunning()) return true;
    for (let i = 0; i < turtleArray().length; i++) {
      const tur = turtleArray()[i];
      if (tur && Array.isArray(tur.queue) && tur.queue.length > 0) return true;
    }
    return false;
  };

  const startRun = async () => {
    await new Promise((r) => setTimeout(r, 50));
    // Preferred: the benchmark bridge's start (calls doFastButton, guarded by
    // the app's _alreadyRunning flag). The #play element is re-rendered by
    // renderPlayIcon() on the real app, so clicking the stale element after
    // init is a no-op and yields an empty run (executionTime == the grace
    // period, drift 0). The bridge is the only path that reliably starts
    // playback; the click remains as a fallback for static mocks.
    if (mb.runner && typeof mb.runner.start === 'function') { mb.runner.start(); return; }
    const playBtn = document.getElementById('play');
    if (playBtn) { playBtn.click(); return; }
    if (mb.logo && typeof mb.logo.run === 'function') { mb.logo.run(); return; }
  };

  // Prove playback actually started. The app begins asynchronously after
  // startRun, so poll isRunning() briefly. A page whose run never starts must
  // fail the sample loudly (null metrics) instead of absorbing the waitDone
  // grace period and reporting a constant bogus executionTime.
  const beginRun = async () => {
    await startRun();
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (isRunning()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  const failMarked = (reason) => {
    ps.playbackFailed = true;
    ps.exec = null;
    ps.maxQueueDepth = null;
    ps.maxActionDepth = null;
    console.warn('[perfsense] playback never started (' + reason + '); run is invalid');
    return {
      executionTime: null,
      maxQueueDepth: null,
      maxActionDepth: null,
      blocksExecuted: null,
      maxDepth: null,
      memoryDelta: null,
      retainedHeap: null
    };
  };

  // Stop playback via the app's own path (doStopTurtles also cancels scheduled
  // transport events). Needed between runs: a play click is a no-op while the
  // engine's _alreadyRunning guard is set by the warm-up run.
  const stopRun = async () => {
    if (!isRunning()) return;
    const logo = mb.logo;
    if (logo && typeof logo.doStopTurtles === 'function') {
      logo.doStopTurtles();
    } else if (mb.runner && typeof mb.runner.stop === 'function') {
      mb.runner.stop();
    }
    const t0 = Date.now();
    while (isRunning() && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const waitDone = async (hardTimeoutMs) => {
    const t0 = Date.now();
    const graceMs = 4000;
    let sawRunning = false;
    for (;;) {
      const runningNow = isRunning();
      if (runningNow) sawRunning = true;
      // Done only after the run has actually started once: the app begins
      // playback asynchronously after the click, so an immediate false must not
      // cut the window short. A run that never starts (broken page) still
      // terminates after the grace period.
      if (sawRunning && !runningNow) break;
      if (!sawRunning && Date.now() - t0 > graceMs) break;
      if (Date.now() - t0 > hardTimeoutMs) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    await new Promise((r) => setTimeout(r, settleMs));
  };

  let maxQ = 0;
  let maxAction = 0;
  const sampler = window.setInterval(() => {
    const list = turtleArray();
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      const tur = list[i];
      if (!tur) continue;
      const queueLen = Array.isArray(tur.queue) ? tur.queue.length : 0;
      const flowLen = Array.isArray(tur.parentFlowQueue) ? tur.parentFlowQueue.length : 0;
      total += queueLen;
      // Action depth: one turtle's pending queue plus its stacked flow
      // parents (Do/Repeat/action-call blocks awaiting completion). This is
      // the semantic the old maxDepth was conflated with; maxDepth now means
      // JS call-stack nesting only, so action depth gets its own probe.
      const action = queueLen + flowLen;
      if (action > maxAction) maxAction = action;
    }
    if (total > maxQ) maxQ = total;
  }, 25);

  const mem = () => {
    // Force a collection before each read: usedJSHeapSize only refreshes after
    // GC, and headless Chromium without --expose-gc never collects between
    // reads, so unforced reads report stale (often zero) deltas. Falls back to
    // a plain read when the browser was launched without --expose-gc.
    try {
      if (typeof window.gc === "function") window.gc();
    } catch (e) {
      void e;
    }
    return typeof performance.memory === "undefined" ? null : performance.memory.usedJSHeapSize;
  };

  try {
    // Warm-up run feeds the retained-memory pattern; executionTime is read from
    // the second run so cold-start allocations do not contaminate it.
    const memBefore = mem();
    if (!(await beginRun())) {
      return failMarked('warm-up run');
    }
    await waitDone(timeoutMs);
    const memAfterFirst = mem();

    // Stop cleanly so the measured run starts fresh (the app ignores play
    // while _alreadyRunning). Also resets transport counters so the latency
    // metrics describe the measured run only.
    await stopRun();
    if (ps.exec) { ps.exec.blocksExecuted = 0; ps.exec.maxDepth = 0; ps.exec.maxLogicalDepth = 0; }
    maxAction = 0;
    maxQ = 0;
    if (ps.transport) {
      ps.transport.latencies = [];
      ps.transport.scheduledTx = [];
      ps.transport.firedAudio = [];
      ps.transport.count = 0;
      ps.transport.onset = null;
      ps.transport.pending = 0;
    }

    const runStart = performance.now();
    if (!(await beginRun())) {
      return failMarked('measured run');
    }
    await waitDone(timeoutMs);
    const runEnd = performance.now();
    const memAfterSecond = mem();

    // PR #7832 natural-completion probe.
    //
    // Cleanup is deferred behind _lastNoteTimeout (js/logo.js:2454-2465, a full
    // second after the last note), so waitDone returns before it lands. Poll on
    // the cleanup latch rather than a fixed sleep: _cleanupAfterCompletion sets
    // _synthsInitialized = false (js/logo.js:1293) and clears every turtle's
    // _transportEventId (js/logo.js:1285-1288). Timing out instead of waiting
    // forever keeps a broken page from burning the run budget.
    let cleanupSeen = false;
    for (let i = 0; i < 60; i++) {
      if (mb.logo && mb.logo._synthsInitialized === false) { cleanupSeen = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    // Reads as: the latch still set (1) plus every turtle still holding a
    // transport handle. Healthy is 0 on both counts.
    let transportHandles = 0;
    try {
      const list = mb.turtles && Array.isArray(mb.turtles.turtleList)
        ? mb.turtles.turtleList
        : [];
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i]._transportEventId != null) transportHandles++;
      }
    } catch (e) {
      void e;
    }
    ps.synthsRetained = mb.logo
      ? (mb.logo._synthsInitialized === true ? 1 : 0) + transportHandles
      : null;
    // PR #7832: sounds must not survive a natural completion. logo.sounds is
    // pushed by the play-sound block (js/blocks/MediaBlocks.js:554) and emptied
    // by _cleanupAfterCompletion (js/logo.js:1248). Structurally 0 on any
    // fixture whose program has no sound block, so it only carries signal where
    // the contract approves it (RainbowConnection, via the export path).
    ps.logoSoundsRetained = Array.isArray(mb.logo.sounds) ? mb.logo.sounds.length : null;
    void cleanupSeen;

    ps.executionTime = runEnd - runStart;
    ps.maxQueueDepth = maxQ;
    ps.maxActionDepth = maxAction;
    if (memBefore !== null && memAfterFirst !== null) ps.memoryDelta = memAfterFirst - memBefore;
    if (memBefore !== null && memAfterSecond !== null) ps.retainedHeap = memAfterSecond - memBefore;
  } finally {
    window.clearInterval(sampler);
  }

  return {
    executionTime: ps.executionTime,
    maxQueueDepth: ps.maxQueueDepth,
    maxActionDepth: ps.maxActionDepth,
    blocksExecuted: ps.exec ? ps.exec.blocksExecuted : null,
    maxDepth: ps.exec ? ps.exec.maxDepth : null,
    maxLogicalDepth: ps.exec ? ps.exec.maxLogicalDepth : null,
    memoryDelta: ps.memoryDelta,
    retainedHeap: ps.retainedHeap
  };
})
`;

/**
 * Exercises the render axis of a loaded workspace and records what it costs.
 *
 * Two phases, because the two performance PRs this covers are reached by
 * different user actions:
 *
 *   A. Pan the workspace end to end with the app's own scroll keys
 *      (END / PAGE_UP / PAGE_DOWN in js/activity/keyboard-controller.js:350-364).
 *      This is what drives PR #7738: culling is only recomputed inside the render
 *      loop when the blocks container has moved (js/activity.js:599-608), and
 *      `stage.update()` (js/activity.js:610) is what gets cheaper once
 *      off-screen blocks leave the display list.
 *
 *      Keyboard rather than a synthetic mouse drag, because the background pan
 *      is gated on `stage.getObjectUnderPoint() === null`
 *      (js/activity.js:1376) and a fully packed workspace has no empty
 *      background to grab.
 *
 *   B. Highlight and unhighlight every block. This is what drives PR #7815:
 *      those two methods hold the guarded `container.updateCache()` calls
 *      (js/block.js:718-719 and :802-803), and panning alone dirties nothing, so
 *      it rebuilds zero caches and measures nothing.
 *
 * The pan's frame window is opened immediately before the first key and closed
 * after the last, so `stageUpdateTime` describes interaction frames only and
 * never the idle frames around them. `panMovedPx` is recorded so a silent no-op
 * (a guard that swallowed the key, a workspace that does not scroll) reads as
 * "the interaction did not happen" rather than as "no regression".
 */
const interactSnippet = `
(async function (__opt) {
  const ps = (window).__perfsense = (window).__perfsense || {};
  const mb = (window).__mb;
  const steps = __opt.panSteps || 24;
  const settleMs = __opt.panSettleMs || 120;
  if (!mb || !mb.blocks || !mb.stage) return { error: 'no-bridge' };
  const render = ps.render;
  // The render collector latches in the metric plugin's setupPostNav. Without it
  // there is nothing to time, and saying so beats reporting a silent 0.
  if (!render) return { error: 'no-render-collector' };

  const blockList = mb.blocks.blockList || {};

  // Count container.updateCache() calls during the pan. Every block container is
  // a createjs.Bitmap, so patching the prototype reached through one live
  // container covers the whole workspace (PR #7815 removed these calls for
  // off-screen blocks, so this count is the metric it regresses).
  let cacheRebuilds = 0;
  let cachePatched = false;
  for (const key in blockList) {
    const holder = blockList[key];
    const c = holder && holder.container;
    if (c && typeof c.updateCache === 'function') {
      const proto = Object.getPrototypeOf(c);
      if (proto && !proto.__perfsenseCachePatched && typeof proto.updateCache === 'function') {
        const orig = proto.updateCache;
        proto.updateCache = function () {
          cacheRebuilds++;
          return orig.apply(this, arguments);
        };
        proto.__perfsenseCachePatched = true;
        cachePatched = true;
      }
      break;
    }
  }

  // Direct #7738 observable: how many blocks culling currently hides. With
  // _updateViewportCulling disabled this stays 0 for the whole pan, which is
  // what separates "culling regressed" from "the pan never happened".
  let maxCulled = 0;
  let blockTotal = 0;
  const sampleCulled = () => {
    let n = 0;
    let total = 0;
    for (const key in blockList) {
      const b = blockList[key];
      if (!b) continue;
      total++;
      if (b._viewportVisible === false) n++;
    }
    blockTotal = total;
    if (n > maxCulled) maxCulled = n;
  };

  const active = document.activeElement;
  if (active && typeof active.blur === 'function') active.blur();

  const press = (keyCode, keyName) => {
    const ev = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true });
    // keyCode is a legacy read-only property, so it has to be defined rather
    // than passed to the constructor.
    Object.defineProperty(ev, 'keyCode', { get: function () { return keyCode; } });
    Object.defineProperty(ev, 'which', { get: function () { return keyCode; } });
    document.dispatchEvent(ev);
  };

  const PAGE_UP = 33, PAGE_DOWN = 34, END = 35;
  const container = mb.render && mb.render.blocksContainer ? mb.render.blocksContainer : null;
  const kick = () => {
    if (mb.render && typeof mb.render.refreshCanvas === 'function') mb.render.refreshCanvas();
  };
  const containerY = () => (container && typeof container.y === 'number' ? container.y : null);

  // --- phase A: pan -------------------------------------------------------
  // Jump to the bottom of the workspace first so the pan traverses the whole
  // stack rather than starting wherever the load left the container.
  press(END, 'End');
  kick();
  await new Promise((r) => setTimeout(r, settleMs));
  sampleCulled();

  const yBefore = containerY();
  render.windowStart = performance.now();
  let done = 0;
  // Cumulative absolute travel, not net displacement. The pan alternates
  // PAGE_DOWN / PAGE_UP by equal amounts, so it returns to where it started and
  // a net delta would read 0 for a pan that scrolled the entire workspace.
  // panMovedPx == 0 has to mean "nothing moved", which is what makes a silent
  // no-op distinguishable from a real pan.
  let travelPx = 0;
  let maxExcursionPx = 0;
  let prevY = yBefore;
  for (let i = 0; i < steps; i++) {
    press(i % 2 === 0 ? PAGE_DOWN : PAGE_UP, i % 2 === 0 ? 'PageDown' : 'PageUp');
    // The scroll keys set stageDirty but do not restart the loop; a real mouse
    // move calls refreshCanvas() to do both (js/activity.js:2154-2159). Mirror
    // that, or the pan is a no-op whenever the loop has already gone idle.
    kick();
    done++;
    await new Promise((r) => setTimeout(r, settleMs));
    sampleCulled();
    const y = containerY();
    if (prevY !== null && y !== null) {
      travelPx += Math.abs(y - prevY);
      prevY = y;
    }
    if (yBefore !== null && y !== null) {
      const exc = Math.abs(y - yBefore);
      if (exc > maxExcursionPx) maxExcursionPx = exc;
    }
  }
  render.windowEnd = performance.now();
  const panMovedPx = containerY() === null ? null : Math.round(travelPx);

  // --- phase B: highlight sweep -------------------------------------------
  // PR #7815 guards container.updateCache() on _viewportVisible in
  // Block.highlight() (js/block.js:718-719) and Block.unhighlight()
  // (js/block.js:802-803). Panning alone never dirties a block, so it
  // rebuilds zero caches and measures nothing; highlighting is what a drag does,
  // and it is the only thing that reaches the guarded call. Sweeping every
  // block makes the off-screen half of the workspace visible to the counter.
  cacheRebuilds = 0;
  let sweepCount = 0;
  for (const key in blockList) {
    const b = blockList[key];
    if (!b || b.trash) continue;
    try {
      if (typeof b.highlight === 'function') b.highlight();
      if (typeof b.unhighlight === 'function') b.unhighlight();
      sweepCount++;
    } catch (e) {
      void e;
    }
  }
  kick();
  await new Promise((r) => setTimeout(r, settleMs));
  sampleCulled();

  render.cacheRebuildCount = cacheRebuilds;
  render.viewportCulledBlocks = maxCulled;
  render.blockTotal = blockTotal;
  // Swept blocks whose highlight/unhighlight did NOT rebuild a cache — the
  // #7815 skip's direct observable. Each swept block issues the two guarded
  // calls; a rebuilt cache was counted, everything else was skipped.
  render.cacheSkippedCount = Math.max(0, sweepCount - cacheRebuilds);
  render.panSteps = done;
  render.panMovedPx = panMovedPx;
  render.highlightSwept = sweepCount;

  const inWindow = render.frames.filter(function (f) {
    return Array.isArray(f) && f[0] >= render.windowStart && f[0] <= render.windowEnd;
  });
  return {
    cacheRebuildCount: cacheRebuilds,
    cachePatched: cachePatched,
    viewportCulledBlocks: maxCulled,
    blockTotal: blockTotal,
    panSteps: done,
    panMovedPx: panMovedPx,
    maxExcursionPx: Math.round(maxExcursionPx),
    highlightSwept: sweepCount,
    frames: inWindow.length,
    frameAvgMs: inWindow.length === 0
      ? null
      : inWindow.reduce(function (s, f) { return s + f[1]; }, 0) / inWindow.length
  };
})
`;

/**
 * Runs the project N times inside one page load and records what survives a
 * natural completion.
 *
 * PR #7848 claims that a natural completion preserves the drawing and disposes
 * runtime state, so the invariants this measures are:
 *   - canvasInkCoverage > 0  : the drawing is still on screen
 *   - canvasInkDrift    ~ 0 : repeated runs do not accumulate ink
 *   - retainedHeapSlope ~ 0 : repeated runs do not retain heap
 *   - logoSoundsRetained   0 : sounds were disposed (PR #7832)
 *   - synthsRetained       0 : instruments were disposed (PR #7832)
 *
 * Two runs cannot show any of this, which is why the old playToCompletion
 * double-run produced a memoryDelta/retainedHeap of exactly 0.
 */
const repeatedRunSnippet = `
(async function (__opt) {
  const ps = (window).__perfsense = (window).__perfsense || {};
  const mb = (window).__mb;
  const runs = __opt.repeatRuns || 10;
  const timeoutMs = __opt.timeoutMs || 120000;
  const perRunMs = Math.max(5000, Math.floor(timeoutMs / Math.max(1, runs)));
  if (!mb || !mb.logo) return { error: 'no-bridge' };

  const logo = mb.logo;

  const gc = () => {
    try { if (typeof window.gc === 'function') window.gc(); } catch (e) { void e; }
  };
  const heap = () => {
    gc();
    return typeof performance.memory === 'undefined' ? null : performance.memory.usedJSHeapSize;
  };

  // Ink coverage: fraction of sampled canvas pixels that differ from the modal
  // (most common) colour. The modal colour is the background, so this reads as
  // "how much is drawn" without hardcoding a palette colour.
  const STRIDE = 4;
  const inkOf = () => {
    const canvas = document.getElementById('myCanvas');
    if (!canvas || !canvas.width || !canvas.height) return null;
    let ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e) { return null; }
    if (!ctx || typeof ctx.getImageData !== 'function') return null;
    let data;
    try {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (e) {
      return null;
    }
    const counts = new Map();
    let sampled = 0;
    const pixels = [];
    for (let i = 0; i < data.length; i += 4 * STRIDE) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
      sampled++;
      pixels.push(key);
    }
    if (sampled === 0) return null;
    let modal = null;
    let modalCount = -1;
    counts.forEach(function (c, k) {
      if (c > modalCount) { modalCount = c; modal = k; }
    });
    let ink = 0;
    for (let i = 0; i < pixels.length; i++) if (pixels[i] !== modal) ink++;
    return ink / sampled;
  };

  const isRunning = () => {
    if (mb.runner && typeof mb.runner.isRunning === 'function' && mb.runner.isRunning()) return true;
    if (mb.turtles && typeof mb.turtles.running === 'function' && mb.turtles.running()) return true;
    if (logo && typeof logo.isRunning === 'function' && logo.isRunning()) return true;
    if (mb.turtles) {
      const list = Array.isArray(mb.turtles) ? mb.turtles
        : Array.isArray(mb.turtles.turtleList) ? mb.turtles.turtleList
        : Array.isArray(mb.turtles.turtles) ? mb.turtles.turtles : [];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t && Array.isArray(t.queue) && t.queue.length > 0) return true;
      }
    }
    return false;
  };

  const startRun = async () => {
    await new Promise((r) => setTimeout(r, 50));
    if (mb.runner && typeof mb.runner.start === 'function') { mb.runner.start(); return; }
    const btn = document.getElementById('play');
    if (btn) { btn.click(); return; }
  };

  const waitQuiet = async (budgetMs) => {
    const t0 = Date.now();
    let saw = false;
    while (Date.now() - t0 < budgetMs) {
      if (isRunning()) saw = true;
      else if (saw) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return saw;
  };

  const inks = [];
  const heaps = [];
  let completed = 0;
  for (let i = 0; i < runs; i++) {
    if (!isRunning()) await startRun();
    const ok = await waitQuiet(perRunMs);
    if (!ok) break;
    // The natural-completion cleanup is deferred behind a timer; give it room
    // before sampling the post-run state.
    await new Promise((r) => setTimeout(r, 600));
    completed++;
    inks.push(inkOf());
    heaps.push(heap());
    if (isRunning()) {
      if (logo && typeof logo.doStopTurtles === 'function') logo.doStopTurtles();
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const cleanInks = inks.filter(function (v) { return typeof v === 'number'; });
  const cleanHeaps = heaps.filter(function (v) { return typeof v === 'number'; });
  const mean = (a) => a.length === 0 ? null : a.reduce(function (s, v) { return s + v; }, 0) / a.length;

  ps.repeatRuns = completed;
  ps.canvasInkCoverage = mean(cleanInks);
  ps.canvasInkDrift = cleanInks.length < 2
    ? null
    : cleanInks[cleanInks.length - 1] - cleanInks[0];
  // Least-squares slope of heap against run index, in bytes per run. A leak
  // shows as a positive slope; a stable program as ~0.
  // PR #7832: same floor as playToCompletion, sampled after the last run.
  // The latch plus any turtle still holding a transport handle.
  let transportHandles = 0;
  try {
    const list = mb.turtles && Array.isArray(mb.turtles.turtleList)
      ? mb.turtles.turtleList
      : [];
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i]._transportEventId != null) transportHandles++;
    }
  } catch (e) {
    void e;
  }
  ps.synthsRetained = logo._synthsInitialized === true ? 1 + transportHandles : transportHandles;
  ps.logoSoundsRetained = Array.isArray(logo.sounds) ? logo.sounds.length : null;

  ps.retainedHeapSlope = cleanHeaps.length < 2 ? null : (function (a) {
    const n = a.length;
    const mx = (n - 1) / 2;
    const my = a.reduce(function (s, v) { return s + v; }, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - mx) * (a[i] - my); den += (i - mx) * (i - mx); }
    return den === 0 ? null : num / den;
  })(cleanHeaps);

  return {
    repeatRuns: completed,
    canvasInkCoverage: ps.canvasInkCoverage,
    canvasInkDrift: ps.canvasInkDrift,
    retainedHeapSlope: ps.retainedHeapSlope,
    synthsRetained: ps.synthsRetained,
    logoSoundsRetained: ps.logoSoundsRetained,
    inkFirst: cleanInks.length ? cleanInks[0] : null,
    inkLast: cleanInks.length ? cleanInks[cleanInks.length - 1] : null,
    heapFirst: cleanHeaps.length ? cleanHeaps[0] : null,
    heapLast: cleanHeaps.length ? cleanHeaps[cleanHeaps.length - 1] : null
  };
})
`;

const SCENARIO_SNIPPETS: Record<ScenarioName, string> = {
  [Scenario.Bootstrap]: bootstrapSnippet,
  [Scenario.OpenProject]: openProjectSnippet,
  [Scenario.PlayToCompletion]: playToCompletionSnippet,
  [Scenario.SaveExport]: saveExportSnippet,
  [Scenario.Interact]: interactSnippet,
  [Scenario.RepeatedRun]: repeatedRunSnippet,
};

export async function callWithArg(
  page: Page,
  snippet: string,
  arg: unknown,
): Promise<unknown> {
  const fn = new Function("__arg", "return (" + snippet + ")(__arg);");
  return page.evaluate(fn as never, arg as never);
}

export async function runScenario(
  name: ScenarioName,
  page: Page,
  options: ScenarioOptions = {},
): Promise<unknown> {
  const snippet = SCENARIO_SNIPPETS[name];
  if (!snippet) return null;
  return callWithArg(page, snippet, options);
}

/** Type guard for scenario names coming from config files. */
export function isScenario(name: string): name is ScenarioName {
  return SCENARIOS.includes(name as ScenarioName);
}
