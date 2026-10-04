import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installRenderCollector, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: 'ms', lowerIsBetter: true, type: 'duration' };

/**
 * Mean cost of one `stage.update()` frame during workspace interaction.
 *
 * PR #7738 (viewport culling) hides off-screen blocks from the display list, and
 * the render loop's `stage.update()` (js/activity.js:610) is what gets cheaper
 * as a result — 4.807 ms -> 1.972 ms average on crabcanon-plot. Nothing measured
 * that before: the config had no render metric at all, so the optimisation was
 * unobservable in either direction.
 *
 * Only frames inside the `interact` scenario's pan window count. Idle frames
 * around the pan are excluded, otherwise the average would be diluted by frames
 * that did no display-list work.
 */
export class StageUpdateTime implements MetricPlugin {
  readonly name = 'stageUpdateTime';
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
    return { name: this.name, value: ps.stageUpdateTime, meta: this.meta };
  }
}
