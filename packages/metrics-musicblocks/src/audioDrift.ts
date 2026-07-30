import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';

const meta: MetricMeta = { unit: 'ms', lowerIsBetter: true, type: 'duration' };
const BEAT_COUNT = 16;
const BEAT_INTERVAL_MS = 125;

export class AudioDrift implements MetricPlugin {
  readonly name = 'audioDrift';
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {
    await page.evaluate(
      ({ count, interval }: { count: number; interval: number }) => {
        const mb = (window as any).__mb;
        if (!mb || typeof mb.testAudioDrift !== 'function') return;

        return new Promise<void>((resolve) => {
          mb.testAudioDrift(count, interval, function (results: Array<{ expected: number; actual: number }>) {
            let maxDrift = 0;
            for (const r of results) {
              const drift = Math.abs(r.actual - r.expected);
              if (drift > maxDrift) maxDrift = drift;
            }
            (window as any).__perfsense.audioDrift = maxDrift;
            resolve();
          });
        });
      },
      { count: BEAT_COUNT, interval: BEAT_INTERVAL_MS }
    );
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    const val = await page.evaluate(() => {
      const p = (window as any).__perfsense;
      return p?.audioDrift ?? null;
    });
    return { name: this.name, value: val, meta: this.meta };
  }
}
