import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installTransportCollector, waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: 'ms', lowerIsBetter: true, type: 'duration' };

/**
 * Per-event audio-timeline scheduling jitter: the mean absolute deviation of
 * each audio-context firing interval from the requested transport interval.
 *
 * Distinct from callbackLatencyMean which compares wall-clock times; schedule
 * lag is the audio-clock side and can be unaffected by main-thread stalls.
 * Resets with the transport arrays each run.
 */
export class ScheduleLagMean implements MetricPlugin {
  readonly name = 'scheduleLagMean';
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
    return { name: this.name, value: ps.scheduleLagMean, meta: this.meta };
  }
}