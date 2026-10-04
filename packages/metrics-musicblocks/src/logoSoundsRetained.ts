import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installTransportCollector, waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: '', lowerIsBetter: true, type: 'count' };

/**
 * Sounds still held by `logo.sounds` after a natural completion (PR #7832).
 *
 * `logo.sounds` is pushed by the play-sound block
 * (`js/blocks/MediaBlocks.js:554`) and emptied by `_cleanupAfterCompletion`
 * (`js/logo.js:1248`). A natural completion that skipped the cleanup leaves
 * every Howl alive and every entry retained, so this reads 0 when the fix works
 * and non-zero when it does not.
 *
 * Lower is better, and 0 is the healthy value — so this is a floor, not a
 * cost. It only carries signal on a fixture that actually plays sounds
 * (RainbowConnection does; musical-tree does not), which is why the contract
 * approves it only where the baseline is non-zero.
 */
export class LogoSoundsRetained implements MetricPlugin {
  readonly name = 'logoSoundsRetained';
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {
    await installTransportCollector(page);
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    await waitForRunEnd(page);
    const ps = await readPerfsense(page);
    return { name: this.name, value: ps.logoSoundsRetained, meta: this.meta };
  }
}
