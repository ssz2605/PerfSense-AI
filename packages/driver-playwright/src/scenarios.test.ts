import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openProjectSnippet, repeatedRunSnippet } from './scenarios';

/**
 * The open-project phase has no completion signal from the app: `projectLoaded`
 * is just `blockList.length > 0`, which is true long before the load finishes.
 * So the harness infers "ready" from the block count holding still.
 *
 * That inference is load-bearing. RainbowConnection is 5.7k blocks decoded in
 * stages, and the count sits still between two stages. When two equal samples
 * were enough, a lull mid-decode ended the wait on about half the runs, which
 * reported projectLoadTime ~20% short and then handed the still-busy app to the
 * export phase. The two metrics moved in opposite directions on all five runs
 * of every capture, and the validity gate rejected the baseline as bimodal.
 *
 * These tests drive the snippet against a scripted block count and pin the
 * behaviour that fixed: a lull must not look like the end of the load.
 */

/** Compile the page snippet against stubbed globals and start it. */
function startOpenProject(blockListLength: () => number) {
  const win: Record<string, any> = {
    __mb: { blocks: { get blockList() { return new Array(blockListLength()); } } },
  };
  const doc = { querySelectorAll: () => [] };
  // The snippet is an IIFE expression, so evaluating it yields the function.
  // Wrapped in parentheses: it opens with a newline, and a bare `return` before
  // a line terminator would be parsed as `return;`.
  const fn = new Function('window', 'document', `return (${openProjectSnippet});`)(win, doc);

  let settled = false;
  const done = fn({ timeoutMs: 120000, fixtureName: 'RainbowConnection.html' }).then(
    () => {
      settled = true;
    },
  );
  return { win, done, settled: () => settled };
}

describe('openProjectSnippet readiness', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not treat a lull between load stages as the end of the load', async () => {
    // 100 is the boot-time default the real app already has; 5000 arrives, then
    // the count stalls for 1.6s the way a decode lull does, then finishes.
    let len = 100;
    const h = startOpenProject(() => len);

    len = 5000;
    await vi.advanceTimersByTimeAsync(2000);

    // The old rule returned true two polls into this stall. Holding steady for
    // the whole lull is the regression this pins.
    expect(h.settled()).toBe(false);

    // The load then resumes, so the stall really was a lull and not the end.
    len = 5700;
    await vi.advanceTimersByTimeAsync(400);

    expect(h.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(4000);
    await h.done;
    expect(h.settled()).toBe(true);
  });

  it('reports a non-negative duration once the count settles', async () => {
    let len = 100;
    const h = startOpenProject(() => len);

    len = 5700;
    await vi.advanceTimersByTimeAsync(6000);
    await h.done;

    const recorded = h.win.__perfsense.projectLoadTime;
    expect(typeof recorded).toBe('number');
    expect(recorded).toBeGreaterThan(0);
    expect(h.win.__perfsense._projectOpened).toBe(true);
  });

  it('falls back to the timeout when no project ever loads', async () => {
    // The page keeps the boot-time block count forever, so the count never
    // differs from initialLen and stability can never be claimed. The probe
    // must run out the clock rather than report a quick, meaningless "ready".
    const h = startOpenProject(() => 100);

    await vi.advanceTimersByTimeAsync(121000);
    await h.done;

    expect(h.win.__perfsense.projectLoadTime).toBeGreaterThanOrEqual(100000);
  });
});

/**
 * The repeated-run scenario samples the LAST run after the deferred
 * `_cleanupAfterCompletion` (js/logo.js:2449-2465, ~1100 ms after the last
 * note). Before this, every run — including the last — slept a fixed 600 ms and
 * so read the pre-cleanup state: the #7832/#7848 blind spot on musical-tree.
 *
 * These tests drive the snippet against a scripted runner and pin both halves:
 * runs 1..N-1 keep the fixed sleep (they must keep overlapping so accumulation
 * across consecutive runs is still observed), and the final run waits on the
 * same bounded latch `playToCompletion` uses, without throwing when it times
 * out.
 */
describe('repeatedRunSnippet final-run cleanup wait', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Compile the snippet against a runner that finishes each run quickly. */
  function startRepeatedRun(runs: number, cleanupAtMs: number | null) {
    const state = { running: true };
    const logo = { _synthsInitialized: true, sounds: [], doStopTurtles() {} };
    const win: Record<string, any> = {
      __mb: {
        logo,
        runner: {
          isRunning: () => state.running,
          start: () => {
            state.running = true;
            setTimeout(() => {
              state.running = false;
            }, 50);
          },
        },
        turtles: { turtleList: [] },
      },
    };
    const doc = { getElementById: () => null, querySelectorAll: () => [] };
    const fn = new Function(
      'window',
      'document',
      `return (${repeatedRunSnippet});`,
    )(win, doc);

    // The first run starts already running, then goes quiet 50 ms in.
    setTimeout(() => {
      state.running = false;
    }, 50);
    // The deferred cleanup, or never when it is absent (gutted cleanup).
    if (cleanupAtMs !== null) {
      setTimeout(() => {
        logo._synthsInitialized = false;
      }, cleanupAtMs);
    }

    let settled = false;
    const done = fn({ repeatRuns: runs, timeoutMs: 120000 }).then((value: unknown) => {
      settled = true;
      return value;
    });
    return { win, done, logo, settled: () => settled };
  }

  it('holds the final sample back until the deferred cleanup lands', async () => {
    const h = startRepeatedRun(2, 1500);

    await vi.advanceTimersByTimeAsync(1400);
    // Both runs are already quiet by then, but the last sample must not have
    // been taken: the cleanup that sets _synthsInitialized = false has not run.
    expect(h.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(400);
    expect(h.settled()).toBe(true);

    const out = (await h.done) as Record<string, number>;
    expect(out.repeatRuns).toBe(2);
    // Read after cleanup, so the synth/transport latch is released.
    expect(out.synthsRetained).toBe(0);
  });

  it('still reports values when cleanup never fires, and says so', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = startRepeatedRun(2, null);

    // The bounded latch gives up 6 s after the final run goes quiet rather
    // than throwing: a broken page must still hand back what it measured.
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(4000);
    expect(h.settled()).toBe(true);

    const out = (await h.done) as Record<string, number>;
    expect(out.repeatRuns).toBe(2);
    expect(out.synthsRetained).toBe(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('final-run cleanup was not observed'),
    );
  });

  it('keeps the fixed sleep for runs 1..N-1 only', () => {
    // The 600 ms sleep must survive for the overlapping runs; the final run
    // waits on the cleanup latch instead.
    expect(repeatedRunSnippet.match(/setTimeout\(r, 600\)/g)).toHaveLength(1);
    expect(repeatedRunSnippet).toContain('i === runs - 1');
    expect(repeatedRunSnippet).toContain('k < 60');
    expect(repeatedRunSnippet).toContain('_synthsInitialized === false');
  });
});
