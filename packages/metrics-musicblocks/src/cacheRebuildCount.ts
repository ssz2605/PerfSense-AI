import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installRenderCollector, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: '', lowerIsBetter: true, type: 'count' };

/**
 * `container.updateCache()` calls during workspace interaction.
 *
 * PR #7815 skipped the per-block bitmap cache rebuild for off-screen blocks
 * (js/block.js:718-719 and :802-803 guard the call on `_viewportVisible`, and
 * js/logo.js:2046-2047 does the same for `markStageDirty`). Every surviving call
 * re-renders a block's cached bitmap, so the count is the direct measure of the
 * work the optimisation removed — and unlike the frame cost it does not depend
 * on how the host schedules frames.
 *
 * Counted by patching `updateCache` on the container prototype reached through
 * one live block, which covers every container of that class in the workspace.
 */
export class CacheRebuildCount implements MetricPlugin {
  readonly name = 'cacheRebuildCount';
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
    return { name: this.name, value: ps.cacheRebuildCount, meta: this.meta };
  }
}
