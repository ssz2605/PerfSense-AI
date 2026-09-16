import { describe, it, expect } from "vitest";
import { logicalDepthOf, LOGICAL_DEPTH_HELPER_SRC } from "./logicalDepth";

describe("logicalDepthOf", () => {
  it("reports 0 for missing turtles", () => {
    expect(logicalDepthOf(null)).toBe(0);
    expect(logicalDepthOf(undefined)).toBe(0);
  });

  it("reports 0 when a turtle has nothing queued and no flow parents", () => {
    expect(logicalDepthOf({ queue: [], parentFlowQueue: [] })).toBe(0);
    expect(logicalDepthOf({})).toBe(0);
  });

  it("counts pending actions in the turtle queue", () => {
    expect(logicalDepthOf({ queue: [1, 2, 3], parentFlowQueue: [] })).toBe(3);
  });

  it("counts stacked flow parents awaiting completion", () => {
    expect(logicalDepthOf({ queue: [], parentFlowQueue: ["do", "repeat"] })).toBe(2);
  });

  it("sums queue and flow depth (logical action recursion)", () => {
    expect(
      logicalDepthOf({ queue: [1, 2, 3, 4], parentFlowQueue: ["a", "b"] }),
    ).toBe(6);
  });

  it("treats non-array queue/flow fields as absent", () => {
    expect(logicalDepthOf({ queue: "nope", parentFlowQueue: 5 })).toBe(0);
  });

  it("exposes a page-rehydratable helper source that matches the implementation", () => {
    const rehydrated = new Function(
      "return (" + LOGICAL_DEPTH_HELPER_SRC + ")",
    )();
    const turtle = { queue: [1, 2], parentFlowQueue: ["a"] };
    expect(rehydrated(turtle)).toBe(logicalDepthOf(turtle));
    expect(rehydrated({ queue: [], parentFlowQueue: [] })).toBe(0);
    expect(rehydrated(null)).toBe(0);
  });
});

describe("runFromBlockNow execution-collector semantics", () => {
  // Mirrors the driver's execution collector exactly: maxDepth tracks
  // synchronous JS nesting of runFromBlockNow; maxLogicalDepth tracks the
  // logical per-turtle depth (queue + parentFlowQueue) at every executed
  // block. These must move independently — that is the whole point of the
  // experimental metric and the reason the approved maxDepth stays untouched.
  //
  // The engine passes a NUMERIC turtle index and resolves the object itself
  // (logo.turtles.ithTurtle at logo.js:1938), so the collector takes the same
  // resolve() step — without it the depth always reads 0.
  function makeCollector(
    logo: { runFromBlockNow: Function },
    resolve: (index: unknown) => unknown,
  ): {
    blocksExecuted: number;
    maxDepth: number;
    depth: number;
    maxLogicalDepth: number;
  } {
    const exec = { blocksExecuted: 0, maxDepth: 0, depth: 0, maxLogicalDepth: 0 };
    const origRun = logo.runFromBlockNow.bind(logo);
    logo.runFromBlockNow = function () {
      exec.depth = exec.depth + 1;
      if (exec.depth > exec.maxDepth) exec.maxDepth = exec.depth;
      let ld = 0;
      try {
        ld = logicalDepthOf(resolve(arguments[1]) as never);
      } catch {
        ld = 0;
      }
      if (ld > exec.maxLogicalDepth) exec.maxLogicalDepth = ld;
      exec.blocksExecuted = exec.blocksExecuted + 1;
      try {
        return origRun.apply(logo, arguments);
      } finally {
        exec.depth = exec.depth - 1;
      }
    };
    return exec;
  }

  interface FakeTurtle {
    queue: unknown[];
    parentFlowQueue: unknown[];
  }

  it("tracks JS nesting and logical depth independently", () => {
    const turtle: FakeTurtle = { queue: [], parentFlowQueue: [] };
    // The engine calls runFromBlockNow with a NUMERIC turtle index; the
    // collector resolves it via ithTurtle (mock: index 0 -> the turtle).
    const resolve = (index: unknown): unknown =>
      index === 0 ? turtle : undefined;
    // Simulates the iterative engine: a flow block pushes its parent frame
    // (mutations between blocks grow logical depth) and synchronously runs
    // one child (grows JS nesting only).
    const logo = {
      runFromBlockNow: (
        _l: unknown,
        _turtle: unknown,
        blk: unknown,
      ): unknown => {
        if (blk === "do") {
          return logo.runFromBlockNow(null, 0, "child");
        }
        return undefined;
      },
    };
    const exec = makeCollector(logo, resolve);

    turtle.parentFlowQueue.push("repeat-1"); // logical 1 on next block
    logo.runFromBlockNow(null, 0, "repeat-1");
    turtle.queue.push("note-a"); // logical 2
    logo.runFromBlockNow(null, 0, "note-a");
    turtle.queue.push("note-b");
    turtle.queue.push("note-c"); // queue 3 + flow 1 = logical 4
    logo.runFromBlockNow(null, 0, "note-b");
    turtle.parentFlowQueue.push("do"); // queue 3 + flow 2 = logical 5
    logo.runFromBlockNow(null, 0, "do"); // JS depth 1, then child at 2

    expect(exec.blocksExecuted).toBe(5); // 4 outer + 1 synchronous child
    expect(exec.maxDepth).toBe(2); // JS nesting only (do -> child)
    expect(exec.maxLogicalDepth).toBe(5); // logical queue + flow peak
  });

  it("reads 0 when the engine passes an un-resolvable index", () => {
    const turtle: FakeTurtle = { queue: [1, 2, 3], parentFlowQueue: ["do"] };
    const resolve = (index: unknown): unknown =>
      index === 0 ? turtle : undefined;
    const logo = {
      runFromBlockNow: (..._args: unknown[]): unknown => undefined,
    };
    const exec = makeCollector(logo, resolve);
    logo.runFromBlockNow(null, 99, "orphan"); // index 99 -> undefined
    expect(exec.maxDepth).toBe(1);
    expect(exec.maxLogicalDepth).toBe(0); // unresolved index contributes 0
  });

  it("keeps simple flat programs at JS nesting 1 with matching logical depth", () => {
    const turtle: FakeTurtle = { queue: [], parentFlowQueue: [] };
    const resolve = (index: unknown): unknown =>
      index === 0 ? turtle : undefined;
    // Real engine drains one queued action per executed block (logo.js pops
    // the last Queue when its count reaches 1), so a flat program never has
    // more than one pending action at a time.
    const logo = {
      runFromBlockNow: (..._args: unknown[]): unknown => {
        if (turtle.queue.length > 0) turtle.queue.pop();
        return undefined;
      },
    };
    const exec = makeCollector(logo, resolve);

    for (let i = 0; i < 5; i++) {
      turtle.queue.push("note");
      logo.runFromBlockNow(null, 0, "note");
    }

    expect(exec.maxDepth).toBe(1);
    expect(exec.maxLogicalDepth).toBe(1); // drained each step: one pending
  });

  it("unwinds depth via finally when a block throws", () => {
    const turtle: FakeTurtle = { queue: [], parentFlowQueue: [] };
    const resolve = (index: unknown): unknown =>
      index === 0 ? turtle : undefined;
    const logo = {
      runFromBlockNow: (..._args: unknown[]): unknown => {
        throw new Error("boom");
      },
    };
    const exec = makeCollector(logo, resolve);
    expect(() => logo.runFromBlockNow(null, 0, "x")).toThrow("boom");
    expect(exec.depth).toBe(0); // exception-safe unwinding preserved
    expect(exec.maxDepth).toBe(1);
  });
});