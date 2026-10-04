import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installRenderCollector, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: '', lowerIsBetter: false, type: 'count' };

/**
 * Peak number of blocks the viewport culler had hidden during the pan.
 *
 * This is the state PR #7738 is supposed to produce, measured directly rather
 * than inferred from frame cost: `_updateViewportCulling()` (js/blocks.js:7125)
 * sets `block._viewportVisible = false` for blocks outside the viewport and the
 * display-list walk skips them. Disable culling and this reads 0 for the whole
 * pan.
 *
 * Kept alongside `stageUpdateTime` because it separates the two ways the
 * measurement can go wrong. If the frame cost does not move, this says whether
 * culling stopped working or whether the pan simply did not happen — without it,
 * "no change" is ambiguous.
 */
export class ViewportCulledBlocks implements MetricPlugin {
  readonly name = 'viewportCulledBlocks';
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
    return { name: this.name, value: ps.viewportCulledBlocks, meta: this.meta };
  }
}
