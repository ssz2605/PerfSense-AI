import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';

const meta: MetricMeta = { unit: 'ms', lowerIsBetter: true, type: 'duration' };
const FRAME_COUNT = 20;
const FRAME_DELAY_MS = 50;
const STAGE_POLL_MS = 250;
const STAGE_TIMEOUT_MS = 90000;

async function waitForStage(page: Page): Promise<void> {
  const start = Date.now();
  for (;;) {
    const ready = await page.evaluate(() => {
      const mb = (window as any).__mb;
      return !!(mb && mb.stage && typeof mb.stage.update === 'function');
    });
    if (ready) return;
    if (Date.now() - start > STAGE_TIMEOUT_MS) {
      throw new Error('stageUpdateTime: timed out waiting for window.__mb.stage');
    }
    await page.waitForTimeout(STAGE_POLL_MS);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('stageUpdateTime: frame loop timed out')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class StageUpdateTime implements MetricPlugin {
  readonly name = 'stageUpdateTime';
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {
    await waitForStage(page);
    await withTimeout(page.evaluate(
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
              try {
                mb.stage.update();
              } catch {
                resolve();
                return;
              }
              count++;
              setTimeout(next, delay);
            }
            next();
          });
        },
        { frames: FRAME_COUNT, delay: FRAME_DELAY_MS }
      ),
      STAGE_TIMEOUT_MS
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
