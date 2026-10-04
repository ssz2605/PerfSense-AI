import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { installTransportCollector, waitForRunEnd, readPerfsense } from './runtime';

const meta: MetricMeta = { unit: '', lowerIsBetter: false, type: 'score' };

/**
 * Share of guarded timer scheduling that went through Tone.Transport rather
 * than the setTimeout fallback — the PR #7703 migration, expressed as one number.
 *
 * `logo.js:1820-1856` is a three-way branch per note delay. The transport branch
 * (1820-1840) calls `logo.synth.transport.schedule` when the clock is available
 * and running; the fallback branch (1841-1856) schedules the same delay through
 * `logo._timerManager.setGuardedTimeout`, which is the setTimeout path #7703
 * replaced. The transport collector counts the first, a wrapper on the timer
 * manager counts the second, and this is their ratio.
 *
 * The denominator is every `setGuardedTimeout` call, not just note delays:
 * logo.js also uses it for the unhighlight queues, the async yield, the
 * notation-export yield and turtleDelay, and embedded-graphics-scheduler.js
 * calls it 17 times on its own. So the value is a share of all guarded
 * scheduling, and a project that leans on embedded graphics dilutes it. It is a
 * seam liveness signal, not a per-delay conversion rate.
 *
 * Reading 1.0 needs a running transport clock. When `isClockRunning` is false
 * the branch at 1824 fails and every note delay takes the fallback, so the ratio
 * reads 0 — which is also what a real #7703 revert looks like. That is why the
 * tripwire compares against baseline share (`seamTripwire.ts`) rather than
 * against 1.0, and why a page with no transport clock cannot carry this metric.
 * Unlike `cumulativeDrift`, it does not depend on the synthesised audio clock
 * being accurate, only on it being running.
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
