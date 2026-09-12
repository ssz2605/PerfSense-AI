import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installExecutionCollector, waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: '', lowerIsBetter: true, type: 'count' };

/**
 * Maximum stacked action depth during a run: one turtle's pending queue plus
 * its parent flow queue (Do/Repeat/action-call blocks awaiting completion).
 * Distinct from maxDepth, which counts only synchronous JS nesting of
 * runFromBlockNow calls. A queue-ladder or recursion PR moves this probe
 * without necessarily moving maxDepth, and vice versa.
 */
export class MaxActionDepth implements MetricPlugin {
  readonly name = 'maxActionDepth';
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
    return { name: this.name, value: ps.maxActionDepth, meta: this.meta };
  }
}