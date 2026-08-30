import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: 'B', lowerIsBetter: true, type: 'count' };

/**
 * Heap retained after the playToCompletion scenario's second identical run.
 * The double-run pattern makes the delta signal memory the run itself
 * (re)allocates, separating leaks from first-run cold-start allocations.
 */
export class RetainedHeap implements MetricPlugin {
  readonly name = 'retainedHeap';
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {}

  async extractMetric(page: Page): Promise<MetricValue> {
    await waitForRunEnd(page);
    const ps = await readPerfsense(page);
    return { name: this.name, value: ps.retainedHeap, meta: this.meta };
  }
}