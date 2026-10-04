import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Page } from "playwright";
import {
  installExecutionCollector,
  installRefreshCanvasCounter,
  readPerfsense,
} from "./runtime";

let win: Record<string, unknown>;

/**
 * Minimal stand-in for a Playwright page: `evaluate` runs the callback (or the
 * snippet source, which is a statement-bodied IIFE exactly as Playwright would
 * run it) against the fake `window` these collectors touch. No browser, no real
 * timers — the wait budgets are passed in explicitly, so a "the bridge never
 * appears" test finishes in milliseconds instead of waiting out the real 90 s.
 */
function fakePage(): Page {
  return {
    evaluate: (fn: unknown, arg?: unknown) => {
      if (typeof fn === "string") {
        return Promise.resolve(new Function("window", fn)(win));
      }
      return Promise.resolve((fn as (a?: unknown) => unknown)(arg));
    },
    waitForTimeout: () => Promise.resolve(),
    addInitScript: () => Promise.resolve(),
  } as unknown as Page;
}

beforeEach(() => {
  win = { __perfsense: {} };
  (globalThis as unknown as Record<string, unknown>).window = win;
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).window;
});

describe("installExecutionCollector", () => {
  it("installs the wrapper even when the Logo bridge appears late", async () => {
    // The real app creates window.__mb at the END of activity init, seconds
    // after the load event, so setupPostNav routinely runs first. Without the
    // bridge wait this collector silently never latched, which is why Rainbow's
    // maxDepth cell never existed.
    const page = fakePage();
    let polls = 0;
    const inner = page.evaluate.bind(page);
    (page as unknown as { evaluate: unknown }).evaluate = (
      fn: unknown,
      arg?: unknown,
    ) => {
      polls++;
      // The bridge shows up on the third poll, as it does on a real cold load.
      if (polls === 3) {
        win.__mb = {
          logo: { runFromBlockNow: () => undefined, turtles: { ithTurtle: () => null } },
        };
      }
      return inner(fn as never, arg as never);
    };

    await installExecutionCollector(page, 2000);
    const ps = win.__perfsense as Record<string, unknown>;
    expect(ps.exec).toBeTruthy();
  });

  it("fails loudly when the bridge never appears", async () => {
    const page = fakePage();
    await expect(installExecutionCollector(page, 50)).rejects.toThrow(
      /execution collector did not install/,
    );
  });

  it("fails loudly when the bridge exists but runFromBlockNow does not", async () => {
    const page = fakePage();
    win.__mb = { logo: { turtles: {} } };
    await expect(installExecutionCollector(page, 50)).rejects.toThrow(
      /execution collector did not install/,
    );
  });

  it("does not re-wrap or reset an already latched collector", async () => {
    const page = fakePage();
    const logo = {
      runFromBlockNow: () => undefined,
      turtles: { ithTurtle: () => null },
    };
    win.__mb = { logo };
    await installExecutionCollector(page, 50);
    const first = (win.__perfsense as Record<string, Record<string, number>>)
      .exec;
    first.blocksExecuted = 41;
    await installExecutionCollector(page, 50);
    const second = (win.__perfsense as Record<string, Record<string, number>>)
      .exec;
    expect(second).toBe(first);
    expect(second.blocksExecuted).toBe(41);
  });
});

describe("installRefreshCanvasCounter", () => {
  it("counts calls through the wrapper and records that it latched", async () => {
    const page = fakePage();
    let calls = 0;
    const refreshCanvas = () => {
      calls++;
    };
    win.__mb = {
      stage: { update: () => undefined },
      render: { refreshCanvas },
    };

    await installRefreshCanvasCounter(page, 2000);
    const render = (win.__mb as Record<string, Record<string, unknown>>).render as
      Record<string, () => void>;
    const ps = win.__perfsense as Record<string, unknown>;
    // Three requests through the wrapper, one direct call on the original.
    render.refreshCanvas();
    render.refreshCanvas();
    render.refreshCanvas();
    refreshCanvas();

    expect(calls).toBe(4);
    expect(ps.refreshCanvasCalls).toBe(3);
    expect(ps.refreshCanvasLatched).toBe(true);
  });

  it("retries until window.__mb.render exists", async () => {
    // __mb.stage and __mb.render are created at different points of activity
    // init. A single attempt that found the stage but not the render object
    // used to give up for good and leave the metric null on all five runs.
    const page = fakePage();
    let polls = 0;
    const inner = page.evaluate.bind(page);
    (page as unknown as { evaluate: unknown }).evaluate = (
      fn: unknown,
      arg?: unknown,
    ) => {
      polls++;
      if (polls >= 4) {
        win.__mb = {
          stage: { update: () => undefined },
          render: { refreshCanvas: () => undefined },
        };
      }
      return inner(fn as never, arg as never);
    };

    await installRefreshCanvasCounter(page, 2000);
    expect(
      (win.__perfsense as Record<string, unknown>).refreshCanvasLatched,
    ).toBe(true);
  });

  it("fails loudly when the render bridge never appears", async () => {
    const page = fakePage();
    win.__mb = { stage: { update: () => undefined } };
    await expect(installRefreshCanvasCounter(page, 50)).rejects.toThrow(
      /refreshCanvas counter did not install/,
    );
    const ps = win.__perfsense as Record<string, unknown>;
    expect(ps.refreshCanvasLatched).toBeUndefined();
    expect(ps.refreshCanvasCalls).toBeUndefined();
  });
});

describe("readPerfsense: latched-zero is not the same as never-installed", () => {
  it("reports a healthy latched 0 as 0", async () => {
    const page = fakePage();
    win.__mb = {
      stage: { update: () => undefined },
      render: { refreshCanvas: () => undefined },
    };
    await installRefreshCanvasCounter(page, 2000);

    const out = await readPerfsense(page);
    expect(out.refreshCanvasCallCount).toBe(0);
    expect(out.refreshCanvasWrapperLatched).toBe(1);
  });

  it("reports a wrapper that never installed as null, never as 0", async () => {
    // 0 is PR #7923's healthy value, so a missing wrapper that reported 0 would
    // be indistinguishable from a healthy build and would sail through the
    // required-metric gate. Null is the only honest reading.
    const page = fakePage();
    const out = await readPerfsense(page);
    expect(out.refreshCanvasCallCount).toBeNull();
    expect(out.refreshCanvasWrapperLatched).toBe(0);
  });

  it("reports maxDepth as null when no execution collector is installed", async () => {
    // The symptom that hid Rainbow's missing cell: ps.exec absent means the
    // collector never latched, and ps.exec present with maxDepth 0 means the
    // program genuinely never recursed. Both must not read as a number.
    const page = fakePage();
    win.__perfsense = {};
    const withoutCollector = await readPerfsense(page);
    expect(withoutCollector.maxDepth).toBeNull();

    win.__perfsense = { exec: { blocksExecuted: 0, maxDepth: 0, maxLogicalDepth: 0 } };
    const zeroDepth = await readPerfsense(page);
    expect(zeroDepth.maxDepth).toBeNull();

    win.__perfsense = {
      exec: { blocksExecuted: 12, maxDepth: 100, maxLogicalDepth: 4 },
    };
    const real = await readPerfsense(page);
    expect(real.maxDepth).toBe(100);
  });
});
