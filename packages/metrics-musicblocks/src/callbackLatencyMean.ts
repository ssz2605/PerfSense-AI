import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installTransportCollector, waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: 'ms', lowerIsBetter: true, type: 'duration' };

/**
 * Mean callback latency from the real PR #7703 scheduler seam
 * (logo.synth.transport.schedule). The migration took mean latency from
 * ~44.95 ms (setTimeout) to ~11.73 ms (Tone transport), so a future PR that
 * regresses scheduler precision is caught here.
 */
export class CallbackLatencyMean implements MetricPlugin {
  readonly name = 'callbackLatencyMean';
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
    return { name: this.name, value: ps.callbackLatencyMean, meta: this.meta };
  }
}