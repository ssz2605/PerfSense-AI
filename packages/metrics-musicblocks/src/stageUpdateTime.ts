import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';

const meta: MetricMeta = { unit: 'ms', lowerIsBetter: true, type: 'duration' };
const FRAME_COUNT = 20;
const FRAME_DELAY_MS = 50;

export class StageUpdateTime implements MetricPlugin {
  readonly name = 'stageUpdateTime';
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {
    await page.evaluate(
      ({ frames, delay }: { frames: number; delay: number }) => {
        const mb = (window as any).__mb;
        if (!mb || !mb.stage || typeof mb.stage.update !== 'function') return;

        const times: number[] = [];
        const origUpdate = mb.stage.update.bind(mb.stage);

        mb.stage.update = function () {
          const start = performance.now();
          origUpdate();
          times.push(performance.now() - start);
        };

        return new Promise<void>((resolve) => {
          let count = 0;
          function next() {
            if (count >= frames) {
              const avg = times.reduce((s: number, t: number) => s + t, 0) / times.length;
              (window as any).__perfsense.stageUpdateTimes = times;
              (window as any).__perfsense.stageUpdateTime = avg;
              resolve();
              return;
            }
            mb.stage.update();
            count++;
            setTimeout(next, delay);
          }
          next();
        });
      },
      { frames: FRAME_COUNT, delay: FRAME_DELAY_MS }
    );
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    const val = await page.evaluate(() => {
      const p = (window as any).__perfsense;
      return p?.stageUpdateTime ?? null;
    });
    return { name: this.name, value: val, meta: this.meta };
  }
}
