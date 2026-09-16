import type { Page } from "playwright";
import type { MetricPlugin, MetricMeta, MetricValue } from "@perfsense/core";
import {
  installExecutionCollector,
  waitForRunEnd,
  readPerfsense,
} from "./runtime";

const meta: MetricMeta = { unit: "", lowerIsBetter: true, type: "count" };

/**
 * Maximum logical (program-level) action depth observed during a run.
 *
 * The engine executes flow recursion ITERATIVELY through the turtle's
 * `queue` and `parentFlowQueue`: entering a flow construct pushes the parent
 * block onto `parentFlowQueue` and a `Queue` entry onto `queue`, and children
 * drain `queue`. The true logical nesting depth at any instant is therefore
 * `queue.length + parentFlowQueue.length` — measured exactly at every
 * executed block (runFromBlockNow entry, with the engine's own
 * `ithTurtle` index resolution at logo.js:1938).
 *
 * This is distinct from the legacy `maxDepth` trace, which only reflects
 * synchronous JS nesting (`== 1`) and is retained as Unverified.
 */
export class MaxLogicalDepth implements MetricPlugin {
  readonly name = "maxLogicalDepth";
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {
    await installExecutionCollector(page);
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    await waitForRunEnd(page);
    const ps = await readPerfsense(page);
    return { name: this.name, value: ps.maxLogicalDepth, meta: this.meta };
  }
}
