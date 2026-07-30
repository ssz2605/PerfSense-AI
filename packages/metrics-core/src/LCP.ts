import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';

const LCP_INIT_SCRIPT = `
  window.__perfsense = window.__perfsense || {};
  new PerformanceObserver((list) => {
    const entries = list.getEntries();
    const last = entries[entries.length - 1];
    if (last) window.__perfsense.lcp = last.renderTime || last.loadTime || last.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
`;

export class LCP implements MetricPlugin {
  readonly name = 'LCP';
  readonly meta: MetricMeta = {
    unit: 'ms',
    lowerIsBetter: true,
    type: 'duration',
  };

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(LCP_INIT_SCRIPT);
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    const value = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const ps = w.__perfsense as Record<string, unknown> | undefined;
      return (ps?.lcp as number | undefined) ?? null;
    });
    return { name: this.name, value, meta: this.meta };
  }
}
