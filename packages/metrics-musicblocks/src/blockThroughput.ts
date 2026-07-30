import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';

const meta: MetricMeta = { unit: 'blocks/s', lowerIsBetter: false, type: 'count' };
const BLOCK_COUNT = 100;

export class BlockThroughput implements MetricPlugin {
  readonly name = 'blockThroughput';
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {
    await page.evaluate(({ count }: { count: number }) => {
      const mb = (window as any).__mb;
      if (!mb || !mb.blockQueue || typeof mb.blockQueue.executeBlock !== 'function') return;

      const origExecute = mb.blockQueue.executeBlock.bind(mb.blockQueue);
      const start = performance.now();
      for (let i = 0; i < count; i++) {
        origExecute();
      }
      const elapsed = performance.now() - start;
      (window as any).__perfsense.blockThroughput = count / (elapsed / 1000);
      (window as any).__perfsense.blockElapsed = elapsed;
      (window as any).__perfsense.blockCount = count;
    }, { count: BLOCK_COUNT });
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    const val = await page.evaluate(() => {
      const p = (window as any).__perfsense;
      return p?.blockThroughput ?? null;
    });
    return { name: this.name, value: val, meta: this.meta };
  }
}
