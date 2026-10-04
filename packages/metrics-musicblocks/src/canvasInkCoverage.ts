import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installTransportCollector, waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: '', lowerIsBetter: false, type: 'score' };

/**
 * Fraction of canvas pixels that differ from the background, averaged over the
 * repeated runs of the `repeatedRun` scenario (PR #7848).
 *
 * The optimisation is that a natural completion preserves the drawing and the
 * canvas is cleared only on an explicit toolbar Run. Ink coverage is how that
 * reads from outside the app: it must be non-zero once the program has drawn,
 * and `canvasInkDrift` (last minus first) is the part that catches accumulation.
 *
 * The background is taken as the modal sampled colour rather than a hardcoded
 * palette entry, so this does not break when the theme changes.
 */
export class CanvasInkCoverage implements MetricPlugin {
  readonly name = 'canvasInkCoverage';
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
    return { name: this.name, value: ps.canvasInkCoverage, meta: this.meta };
  }
}
