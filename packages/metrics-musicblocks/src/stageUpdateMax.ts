import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installRenderCollector, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: 'ms', lowerIsBetter: true, type: 'duration' };

/**
 * Worst single `stage.update()` frame during workspace interaction.
 *
 * The mean frame cost can hide a stall: culling that skips the display list for
 * off-screen blocks still has to walk every on-screen block, so a workspace that
 * fits in one screen behaves the same while a large one does not. The max frame
 * is where that shows up, and it is the number a user feels as a hitch while
 * panning.
 */
export class StageUpdateMax implements MetricPlugin {
  readonly name = 'stageUpdateMax';
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {
    await installRenderCollector(page);
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    const ps = await readPerfsense(page);
    return { name: this.name, value: ps.stageUpdateMax, meta: this.meta };
  }
}
