import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';

const meta: MetricMeta = { unit: 'ms', lowerIsBetter: true, type: 'duration' };

export class PlaybackLatency implements MetricPlugin {
  readonly name = 'playbackLatency';
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {
    await page.evaluate(() => {
      const mb = (window as any).__mb;
      if (!mb || typeof mb.startPlayback !== 'function') return;

      const orig = mb.startPlayback.bind(mb);
      mb.startPlayback = function (cb: (() => void) | undefined) {
        const start = performance.now();
        orig(function () {
          (window as any).__perfsense.playbackLatency = performance.now() - start;
          if (cb) cb();
        });
      };

      mb.startPlayback(function () {});
    });
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    const val = await page.evaluate(() => {
      const p = (window as any).__perfsense;
      return p?.playbackLatency ?? null;
    });
    return { name: this.name, value: val, meta: this.meta };
  }
}
