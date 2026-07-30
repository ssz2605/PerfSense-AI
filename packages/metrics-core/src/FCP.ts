import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';

const FCP_INIT_SCRIPT = `
  window.__perfsense = window.__perfsense || {};
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === 'first-contentful-paint') {
        window.__perfsense.fcp = entry.startTime;
      }
    }
  }).observe({ type: 'paint', buffered: true });
`;

export class FCP implements MetricPlugin {
  readonly name = 'FCP';
  readonly meta: MetricMeta = {
    unit: 'ms',
    lowerIsBetter: true,
    type: 'duration',
  };

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(FCP_INIT_SCRIPT);
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    const value = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const ps = w.__perfsense as Record<string, unknown> | undefined;
      return (ps?.fcp as number | undefined) ?? null;
    });
    return { name: this.name, value, meta: this.meta };
  }
}
