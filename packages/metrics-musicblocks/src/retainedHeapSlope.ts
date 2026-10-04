import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installTransportCollector, waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: 'B/run', lowerIsBetter: true, type: 'score' };

/**
 * Least-squares slope of retained heap against run index, in bytes per run,
 * across the `repeatedRun` scenario (PR #7848).
 *
 * An endpoint delta cannot see a leak here: the old two-run probe produced
 * `memoryDelta` and `retainedHeap` of exactly 0 on every capture, because
 * headless Chromium serves `performance.memory` from a coarse cache unless
 * `--enable-precise-memory-info` is set. A slope over N runs is also a different
 * measurement — a program that allocates and frees identically every run has a
 * near-zero slope even as the absolute heap moves, while a program that retains
 * a little per run has a positive slope even if the last run happens to land
 * near the first.
 *
 * Reads as bytes per run, so the threshold is stated in those units rather than
 * as a percentage of a median that is dominated by cold-start allocations.
 */
export class RetainedHeapSlope implements MetricPlugin {
  readonly name = 'retainedHeapSlope';
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {
    await installTransportCollector(page);
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    await waitForRunEnd(page);
    const ps = await readPerfsense(page);
    return { name: this.name, value: ps.retainedHeapSlope, meta: this.meta };
  }
}
