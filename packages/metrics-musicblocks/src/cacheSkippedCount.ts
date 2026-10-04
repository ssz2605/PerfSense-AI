import type { Page } from "playwright";
import type { MetricPlugin, MetricMeta, MetricValue } from "@perfsense/core";
import { installRenderCollector, readPerfsense } from "./runtime";

const meta: MetricMeta = { unit: "", lowerIsBetter: false, type: "count" };

/**
 * Highlight sweeps that skipped the per-block cache rebuild.
 *
 * Paired with cacheRebuildCount: a sweep of the workspace touches every
 * swept block, and PR #7815 skips `updateCache()`/`markStageDirty` for the
 * off-screen ones (js/block.js:718-719, :802-803; js/logo.js:2046). The
 * number of swept blocks that did NOT rebuild a cache is the visible
 * count of what the optimisation skips. Reverting it sends this to ~0 and
 * cacheRebuildCount up to the swept total.
 */
export class CacheSkippedCount implements MetricPlugin {
  readonly name = "cacheSkippedCount";
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {
    await installRenderCollector(page);
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    const ps = await readPerfsense(page);
    return { name: this.name, value: ps.cacheSkippedCount, meta: this.meta };
  }
}
