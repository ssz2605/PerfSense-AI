import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: 'B', lowerIsBetter: true, type: 'count' };

/**
 * Peak `usedJSHeapSize` observed while the save and export phases ran.
 *
 * PR #7970 made exports ~23x faster by running the program synchronously and
 * yielding every 100 block transitions, and documented the cost honestly: peak
 * memory went from ~1.3 MB to ~27 MB. The speed side is measured
 * (`exportMIDITime`, `saveAsLilypondTime`); the memory side was not, so a later
 * PR could raise peak export memory arbitrarily and no cell would move.
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
