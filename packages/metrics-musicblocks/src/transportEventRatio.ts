import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installTransportCollector, waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: '', lowerIsBetter: false, type: 'score' };

/**
 * Share of note delays that went through Tone.Transport rather than the
 * setTimeout fallback — the PR #7703 migration, expressed as one number.
 *
 * `logo.js:1820-1856` is a three-way branch per note delay. The transport branch
 * (1820-1840) calls `logo.synth.transport.schedule` when the clock is available
 * and running; the fallback branch (1841-1856) schedules the same delay through
 * `logo._timerManager.setGuardedTimeout`, which is the setTimeout path #7703
 * replaced. The transport collector counts the first, a wrapper on the timer
 * manager counts the second, and this is their ratio. `setGuardedTimeout` is
 * called from nowhere else in the app, so the denominator is exact.
 *
 * A healthy run reads 1.0. Clock-independent by construction — unlike
 * `cumulativeDrift`, which collapses to ~1e-9 ms on headless Chromium's
 * synthesised audio clock and therefore cannot see a regression at all.
 *
 * Null when either counter is missing, so a dead seam reads as "no data" rather
 * than as a healthy ratio.
 */
export class TransportEventRatio implements MetricPlugin {
  readonly name = 'transportEventRatio';
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
    return { name: this.name, value: ps.transportEventRatio, meta: this.meta };
  }
}
