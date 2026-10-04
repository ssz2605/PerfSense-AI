import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installRenderCollector, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: '', lowerIsBetter: true, type: 'count' };

/**
 * How many `stage.update()` frames the project load actually painted.
 *
 * PR #7923 sets `_suppressRefresh` for the duration of a load so
 * `refreshCanvas()` returns early (js/activity.js:2152-2159), `stageDirty` is
 * never set while blocks are being decoded, and the render loop goes idle. That
 * is the mechanism behind Rainbow Connection's 19.4 s -> 9.5 s load, but
 * `projectLoadTime` only sees its side effect: the clock stops when the block
 * count stops growing (see the `openProject` readiness rule), so it cannot tell
 * "the load was cheap because nothing was painted" from "the load was cheap
 * because there was less to do".
 *
 * This counts the painted frames directly, from `perfMarks.openStart`, so a
 * partially reverted suppression — a few refreshes too many rather than all of
 * them — still moves it.
 */
export class StageUpdateCallCount implements MetricPlugin {
  readonly name = 'stageUpdateCallCount';
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
    return { name: this.name, value: ps.stageUpdateCallCount, meta: this.meta };
  }
}
