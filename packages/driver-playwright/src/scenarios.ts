import type { Page } from "playwright";

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
} as const;

export type ScenarioName = (typeof Scenario)[keyof typeof Scenario];

export interface ScenarioOptions {
  fixtureName?: string;
  timeoutMs?: number;
  settleMs?: number;
}

export const SCENARIOS: readonly ScenarioName[] = [
  Scenario.Bootstrap,
  Scenario.OpenProject,
  Scenario.PlayToCompletion,
  Scenario.SaveExport,
];

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

const openProjectSnippet = `
(async function (__opt) {
  const ps = (window).__perfsense = (window).__perfsense || {};
  const timeoutMs = __opt.timeoutMs || 120000;
  const startMs = Date.now();
  const openStart = performance.now();
  const bridgeMark = (() => {
    const mb = (window).__mb || {};
    return (mb.perfMarks && typeof mb.perfMarks.openStart === 'number') ? mb.perfMarks.openStart : null;
  })();
  // "Render ready" means the workspace stopped growing: two consecutive
  // samples taken ~400ms apart equal each other (and differ from the boot-time
  // baseline, which is non-empty by default in the real app). On the real app
  // blocks render to the canvas, so count blocks.blockList rather than DOM
  // ".block" nodes; mocks without that surface fall back to the DOM count.
  // window.__mb is read live every sample: it may not exist yet at scenario
  // start on cold pages.
  const blockCount = () => {
    const mb = (window).__mb || {};
    if (mb.blocks && Array.isArray(mb.blocks.blockList)) return mb.blocks.blockList.length;
    return (document.querySelectorAll('#blockTable .block, .blockTable .block, #blocks .block')).length;
  };
  const initialLen = blockCount();
  const waitStable = async () => {
    let prev = -1;
    let rounds = 0;
    for (;;) {
      if (Date.now() - startMs > timeoutMs) return false;
      const cur = blockCount();
      if (cur === prev && cur > 0 && cur !== initialLen) {
        rounds += 1;
        if (rounds >= 2) return true;
      } else {
        rounds = 0;
      }
      prev = cur;
      await new Promise((r) => setTimeout(r, 400));
    }
  };
  let ready = await waitStable();
  if (!ready) {
    // No renderable block table (e.g. minimal mocks): fall back to the bridge's
    // ready flag, then settle so the app finishes any async decode.
    for (;;) {
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
  void startMs; void timeoutMs;
  return { saveTime: ps.saveTime, exportMIDITime: ps.exportMIDITime };
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
  // pop/shift, so blocksExecuted counts that entry point and maxDepth its nesting.
  if (!ps.execLatched && mb.logo) {
    ps.execLatched = true;
    ps.exec = { blocksExecuted: 0, maxDepth: 0, depth: 0 };
    const logo = mb.logo;
    const origRun = logo.runFromBlockNow.bind(logo);
    logo.runFromBlockNow = function () {
      const exec = ps.exec;
      exec.depth = exec.depth + 1;
      if (exec.depth > exec.maxDepth) exec.maxDepth = exec.depth;
      exec.blocksExecuted = exec.blocksExecuted + 1;
      try { return origRun.apply(logo, arguments); } finally { exec.depth = exec.depth - 1; }
    };
  }

  const isRunning = () => {
    if (mb.runner && typeof mb.runner.isRunning === 'function' && mb.runner.isRunning()) return true;
    if (mb.turtles && typeof mb.turtles.running === 'function' && mb.turtles.running()) return true;
    // Scheduled-but-unfired transport events mean playback is still pending:
    // the flat block-stepping loop ends long before the last scheduled note
    // fires. Without this, waitDone returns after the sync segment only.
    if (ps.transport && ps.transport.pending > 0) return true;
    if (mb.logo && typeof mb.logo.isRunning === 'function' && mb.logo.isRunning()) return true;
    const list = Array.isArray(mb.turtles) ? mb.turtles :
      (mb.turtles && Array.isArray(mb.turtles.turtles)) ? mb.turtles.turtles : [];
    for (let i = 0; i < list.length; i++) {
      if (list[i] && Array.isArray(list[i].queue) && list[i].queue.length > 0) return true;
    }
    return false;
  };

  const startRun = async () => {
    await new Promise((r) => setTimeout(r, 50));
    const playBtn = document.getElementById('play');
    if (playBtn) { playBtn.click(); return; }
    if (mb.runner && typeof mb.runner.start === 'function') { mb.runner.start(); return; }
    if (mb.logo && typeof mb.logo.run === 'function') { mb.logo.run(); return; }
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
  const sampler = window.setInterval(() => {
    const list = Array.isArray(mb.turtles) ? mb.turtles :
      (mb.turtles && Array.isArray(mb.turtles.turtles)) ? mb.turtles.turtles : [];
    let total = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && Array.isArray(list[i].queue)) total += list[i].queue.length;
    }
    if (total > maxQ) maxQ = total;
  }, 25);

  const mem = () => (typeof performance.memory === 'undefined' ? null : performance.memory.usedJSHeapSize);

  try {
    // Warm-up run feeds the retained-memory pattern; executionTime is read from
    // the second run so cold-start allocations do not contaminate it.
    const memBefore = mem();
    await startRun();
    await waitDone(timeoutMs);
    const memAfterFirst = mem();

    // Stop cleanly so the measured run starts fresh (the app ignores play
    // while _alreadyRunning). Also resets transport counters so the latency
    // metrics describe the measured run only.
    await stopRun();
    if (ps.exec) { ps.exec.blocksExecuted = 0; ps.exec.maxDepth = 0; }
    if (ps.transport) {
      ps.transport.latencies = [];
      ps.transport.scheduledTx = [];
      ps.transport.firedAudio = [];
      ps.transport.count = 0;
      ps.transport.onset = null;
      ps.transport.pending = 0;
    }

    const runStart = performance.now();
    await startRun();
    await waitDone(timeoutMs);
    const runEnd = performance.now();
    const memAfterSecond = mem();

    ps.executionTime = runEnd - runStart;
    ps.maxQueueDepth = maxQ;
    if (memBefore !== null && memAfterFirst !== null) ps.memoryDelta = memAfterFirst - memBefore;
    if (memBefore !== null && memAfterSecond !== null) ps.retainedHeap = memAfterSecond - memBefore;
  } finally {
    window.clearInterval(sampler);
  }

  return {
    executionTime: ps.executionTime,
    maxQueueDepth: ps.maxQueueDepth,
    blocksExecuted: ps.exec ? ps.exec.blocksExecuted : null,
    maxDepth: ps.exec ? ps.exec.maxDepth : null,
    memoryDelta: ps.memoryDelta,
    retainedHeap: ps.retainedHeap
  };
})
`;

const SCENARIO_SNIPPETS: Record<ScenarioName, string> = {
  [Scenario.Bootstrap]: bootstrapSnippet,
  [Scenario.OpenProject]: openProjectSnippet,
  [Scenario.PlayToCompletion]: playToCompletionSnippet,
  [Scenario.SaveExport]: saveExportSnippet,
};

async function callWithArg(
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
