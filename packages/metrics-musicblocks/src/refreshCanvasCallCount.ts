import type { Page } from "playwright";
import type { MetricPlugin, MetricMeta, MetricValue } from "@perfsense/core";
import { installRefreshCanvasCounter, readPerfsense } from "./runtime";

const meta: MetricMeta = { unit: "", lowerIsBetter: true, type: "count" };

/**
 * Calls to `refreshCanvas()` across the run.
 *
 * PR #7923 set `_suppressRefresh` (js/activity.js:2152-2159), so the
 * project-load path no longer repaints between decode stages — the
 * healthy build keeps this counter low through openProject. Removing
 * the guard raises it into the hundreds, which is the diff this cell
 * exists to catch even when projectLoadTime stays within noise.
 */
export class RefreshCanvasCallCount implements MetricPlugin {
  readonly name = "refreshCanvasCallCount";
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {
    await installRefreshCanvasCounter(page);
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    const ps = await readPerfsense(page);
    return {
      name: this.name,
      value: ps.refreshCanvasCallCount,
      meta: this.meta,
    };
  }
}
