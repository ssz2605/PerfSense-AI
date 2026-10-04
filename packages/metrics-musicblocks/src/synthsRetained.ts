import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installTransportCollector, waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: '', lowerIsBetter: true, type: 'count' };

/**
 * Instruments still live after a natural completion (PR #7832).
 *
 * The natural-completion path is the deferred `_lastNoteTimeout` callback at
 * `js/logo.js:2454-2465`, which calls `_cleanupAfterCompletion()`. That is what
 * disposes every instrument and clears the per-turtle transport handles
 * (`js/logo.js:1292` and :1285-1288), and it sets `_synthsInitialized = false`
 * as its "cleanup already ran" latch (`js/logo.js:1240`, :1293).
 *
 * This reads both as a single floor: 0 when cleanup ran, 1 when the latch is
 * still set and every instrument is still live. Latch-only would be enough to
 * detect the revert, but a handler count is included so a partial teardown — the
 * latch cleared while handles survive — cannot pass as healthy.
 *
 * Why not the stop list. The obvious reading of "did the natural completion run
 * its stop hooks" is `logo.evalOnStopList`, and it cannot be used here for two
 * independent reasons. Nothing ever deletes keys from that dict, so its length
 * is a constant and says nothing about cleanup. And natural completion
 * deliberately does not execute it at all — `js/logo.js:1336-1338` sits in
 * `doStopTurtles()`, the explicit-stop path, and
 * `js/__tests__/logo.test.js:2254` asserts that a natural completion does not
 * run it. A sentinel registered there would read 0 both when the fix works and
 * when it is reverted, so it would pass forever.
 *
 * Lower is better and 0 is the healthy value, so this is a floor, not a cost.
 */
export class SynthsRetained implements MetricPlugin {
  readonly name = 'synthsRetained';
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
    return { name: this.name, value: ps.synthsRetained, meta: this.meta };
  }
}