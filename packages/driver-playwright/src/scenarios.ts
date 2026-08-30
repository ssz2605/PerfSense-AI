import type { Page } from 'playwright';

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
  Bootstrap: 'bootstrap',
  OpenProject: 'openProject',
  PlayToCompletion: 'playToCompletion',
  SaveExport: 'saveExport'
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
  Scenario.SaveExport
];

const bootstrapSnippet = `
(async function (__opt) {
  const ps = (window).__perfsense = (window).__perfsense || {};
  const timeoutMs = __opt.timeoutMs || 120000;
  const startMs = Date.now();
  // Wait for the app's bootstrap marks to land.
  for (;;) {
    const hasMarks = !!(ps.bootstrapTotal !== undefined && ps.initTotal !== undefined) || !!(window).__mbPerf;
    if (hasMarks) break;
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
    ps.bootstrapTotal = (s !== null && e !== null && e > s) ? (e - s) : pick(['bootstrapTotal', 'bootTime', 'loader_to_activity_init_complete']);
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
  const mb = (window).__mb || {};
  const bridgeMark = (mb.perfMarks && typeof mb.perfMarks.openStart === 'number') ? mb.perfMarks.openStart : null;
  // Wait for the project to be rendered: block table populated (falling back
  // to the bridge's ready flag when the app provides it).
  for (;;) {
    let loaded = false;
    if (mb.blocks && typeof mb.blocks.projectLoaded === 'function') {
      loaded = mb.blocks.projectLoaded();
    }
    const blockCount = (document.querySelectorAll('#blockTable .block, .blockTable .block')).length;
    if (loaded || blockCount > 0) {
      await new Promise((r) => setTimeout(r, 300));
      break;
    }
    if (Date.now() - startMs > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 100));
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
    ps.transport = { latencies: [], scheduledTx: [], firedAudio: [], onset: null, count: 0 };
    transport.schedule = function (cb, time) {
      const scheduleWall = performance.now();
      return origSchedule(function (audioContextTime) {
        const firedWall = performance.now();
        const t = ps.transport;
        t.latencies.push(firedWall - scheduleWall);
        t.scheduledTx.push(typeof time === 'number' ? time : null);
        t.firedAudio.push(typeof audioContextTime === 'number' ? audioContextTime : null);
        t.count = t.count + 1;
        if (t.onset === null) t.onset = firedWall - scheduleWall;
        if (typeof cb === 'function') cb(audioContextTime);
      }, time);
    };
  }

  // --- install execution collector (idempotent) ---
  if (!ps.execLatched && mb.logo) {
    ps.execLatched = true;
    ps.exec = { blocksExecuted: 0, maxDepth: 0, depth: 0 };
    const logo = mb.logo;
    const origRun = logo.runFromBlockNow.bind(logo);
    logo.runFromBlockNow = function () {
      const exec = ps.exec;
      exec.depth = exec.depth + 1;
      if (exec.depth > exec.maxDepth) exec.maxDepth = exec.depth;
      try { return origRun.apply(logo, arguments); } finally { exec.depth = exec.depth - 1; }
    };
    const wrapQueue = (q) => {
      if (!q || q.__perfsenseWrapped) return;
      q.__perfsenseWrapped = true;
      const origPop = q.pop; const origShift = q.shift;
      if (typeof origPop === 'function') {
        q.pop = function () { ps.exec.blocksExecuted = ps.exec.blocksExecuted + 1; return origPop.apply(this, arguments); };
      }
      if (typeof origShift === 'function') {
        q.shift = function () { ps.exec.blocksExecuted = ps.exec.blocksExecuted + 1; return origShift.apply(this, arguments); };
      }
    };
    const turtleList = () => Array.isArray(mb.turtles) ? mb.turtles :
      (mb.turtles && Array.isArray(mb.turtles.turtles)) ? mb.turtles.turtles : [];
    const wrapTurtles = () => {
      const list = turtleList();
      for (let i = 0; i < list.length; i++) {
        if (list[i] && Array.isArray(list[i].queue)) wrapQueue(list[i].queue);
      }
    };
    wrapTurtles();
    if (mb.turtles && typeof mb.turtles.addTurtle === 'function') {
      const origAdd = mb.turtles.addTurtle.bind(mb.turtles);
      mb.turtles.addTurtle = function () { const t = origAdd.apply(this, arguments); wrapTurtles(); return t; };
    }
  }

  const isRunning = () => {
    if (mb.runner && typeof mb.runner.isRunning === 'function') return mb.runner.isRunning();
    if (mb.logo && typeof mb.logo.isRunning === 'function') return mb.logo.isRunning();
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

  const waitDone = async (hardTimeoutMs) => {
    const t0 = Date.now();
    for (;;) {
      if (!isRunning()) break;
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

    if (ps.exec) { ps.exec.blocksExecuted = 0; ps.exec.maxDepth = 0; }

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
  [Scenario.SaveExport]: saveExportSnippet
};

async function callWithArg(page: Page, snippet: string, arg: unknown): Promise<unknown> {
  const fn = new Function('__arg', 'return (' + snippet + ')(__arg);');
  return page.evaluate(fn as never, arg as never);
}

export async function runScenario(
  name: ScenarioName,
  page: Page,
  options: ScenarioOptions = {}
): Promise<unknown> {
  const snippet = SCENARIO_SNIPPETS[name];
  if (!snippet) return null;
  return callWithArg(page, snippet, options);
}

/** Type guard for scenario names coming from config files. */
export function isScenario(name: string): name is ScenarioName {
  return SCENARIOS.includes(name as ScenarioName);
}