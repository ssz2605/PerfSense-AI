import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: 'B', lowerIsBetter: true, type: 'count' };

/**
 * Peak `usedJSHeapSize` observed while the save and export phases ran.
 *
 * This cell reports a total heap reading, not a delta: the v2 baseline's median
 * for RainbowConnection is ~165,000,000 bytes of live heap during the phase.
 * PR #7970 quoted ~1.3 MB -> ~27 MB for its own cost in that PR's terms; those
 * figures are not what this cell reads and must not be compared against them.
 *
 * PR #7970 made exports ~23x faster by running the program synchronously and
 * yielding every 100 block transitions. The speed side is measured
 * (`exportMIDITime`, `saveAsLilypondTime`); the memory side is measured here,
 * so a later PR that raises peak export memory moves a cell instead of passing
 * unnoticed.
 *
 * Sampled every 100 ms during the phase. No forced GC: calling `window.gc()` on
 * that cadence would distort the export timings this phase exists to measure,
 * and `--enable-precise-memory-info` already keeps the reading live between
 * collections.
 */
export class PeakHeapDuringExport implements MetricPlugin {
  readonly name = 'peakHeapDuringExport';
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {}

  async extractMetric(page: Page): Promise<MetricValue> {
    await waitForRunEnd(page);
    const ps = await readPerfsense(page);
    return { name: this.name, value: ps.peakHeapDuringExport, meta: this.meta };
  }
}
