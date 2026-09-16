import type { Page } from "playwright";
import type { MetricPlugin, MetricMeta, MetricValue } from "@perfsense/core";
import { installTransportCollector, waitForRunEnd, readPerfsense } from "./runtime";

const meta: MetricMeta = { unit: "", lowerIsBetter: false, type: "count" };

/**
 * Number of `transport.schedule` events that actually fired during a run.
 *
 * Experimental #7703 seam-sanity signal (Layer A). A live Tone.Transport seam
 * schedules hundreds of events (Frère Jacques ≈ 268 notes × voices); a revert
 * of the scheduling migration back to setTimeout records zero transport
 * events, which nulls every audio metric. This count turns that into an
 * explicit, clock-independent signal.
 *
 * Not part of the approved Benchmark Matrix yet — extracted for evaluation and
 * future seam tripwiring, deliberately excluded from baselines/reports.
 */
export class ScheduleCount implements MetricPlugin {
  readonly name = "scheduleCount";
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
    return { name: this.name, value: ps.scheduleCount, meta: this.meta };
  }
}