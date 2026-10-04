import type { Page } from "playwright";
import type { MetricPlugin, MetricMeta, MetricValue } from "@perfsense/core";
import {
  installTransportCollector,
  waitForRunEnd,
  readPerfsense,
} from "./runtime";

const meta: MetricMeta = { unit: "", lowerIsBetter: false, type: "count" };

/**
 * Number of note delays that took the Tone.Transport branch (PR #7703).
 *
 * Same numerator as transportEventRatio, as an absolute count: the ratio
 * divides by every guarded-timer call in the program, so an unrelated
 * scheduler change can move it without touching a single scheduled note.
 * A #7703 revert drives this to 0.
 */
export class TransportEventCount implements MetricPlugin {
  readonly name = "transportEventCount";
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
    return { name: this.name, value: ps.transportEventCount, meta: this.meta };
  }
}
