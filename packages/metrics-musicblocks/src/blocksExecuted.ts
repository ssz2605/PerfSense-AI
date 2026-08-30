import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installExecutionCollector, waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: '', lowerIsBetter: true, type: 'count' };

/**
 * Total number of blocks drained from turtle queues during a run.
 * Deliberately a sanity metric: a regression that drastically changes the
 * blocks executed (infinite loops, early exits) is caught even if timing is
 * not yet statistically significant.
 */
export class BlocksExecuted implements MetricPlugin {
  readonly name = 'blocksExecuted';
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
    return { name: this.name, value: ps.blocksExecuted, meta: this.meta };
  }
}