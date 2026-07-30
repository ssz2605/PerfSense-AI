import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';

export class TTFB implements MetricPlugin {
  readonly name = 'TTFB';
  readonly meta: MetricMeta = {
    unit: 'ms',
    lowerIsBetter: true,
    type: 'duration',
  };

  async setupPage(_page: Page): Promise<void> {
    // TTFB is read from the Navigation Timing API — no setup needed
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    const value = await page.evaluate(() => {
      const entries = performance.getEntriesByType('navigation');
      const nav = entries.length > 0 ? entries[0] as PerformanceNavigationTiming : undefined;
      if (!nav) return null;
      return nav.responseStart - nav.startTime;
    });
    return { name: this.name, value, meta: this.meta };
  }
}
