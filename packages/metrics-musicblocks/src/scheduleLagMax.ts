import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installTransportCollector, waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: 'ms', lowerIsBetter: true, type: 'duration' };

/**
 * Worst per-event audio-timeline scheduling jitter: the maximum absolute
 * deviation of an audio-context firing interval from its requested transport
 * interval. Distinct from callbackLatencyMax (wall clock) and reset with the
 * transport arrays each run.
 */
export class ScheduleLagMax implements MetricPlugin {
  readonly name = 'scheduleLagMax';
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
    return { name: this.name, value: ps.scheduleLagMax, meta: this.meta };
  }
}