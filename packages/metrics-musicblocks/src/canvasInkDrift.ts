import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installTransportCollector, waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: '', lowerIsBetter: true, type: 'score' };

/**
 * Change in canvas ink coverage between the first and last of the repeated runs
 * (PR #7848).
 *
 * `canvasInkCoverage` alone cannot separate "drawing preserved" from "drawing
 * wiped": both can produce a stable coverage, at completely different absolute
 * values. The invariant #7848 actually claims is that N consecutive natural
 * completions leave the canvas where the first one did, so the quantity to watch
 * is the drift between them. Zero drift is healthy; a positive drift means every
 * run is adding to the canvas, and a large negative drift means the drawing is
 * being cleared.
 *
 * Reported as a signed ratio, so it needs thresholds in both directions.
 */
export class CanvasInkDrift implements MetricPlugin {
  readonly name = 'canvasInkDrift';
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
    return { name: this.name, value: ps.canvasInkDrift, meta: this.meta };
  }
}
