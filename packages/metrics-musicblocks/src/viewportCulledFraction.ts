import type { Page } from "playwright";
import type { MetricPlugin, MetricMeta, MetricValue } from "@perfsense/core";
import { installRenderCollector, readPerfsense } from "./runtime";

const meta: MetricMeta = { unit: "", lowerIsBetter: false, type: "score" };

/**
 * Peak share of the workspace the viewport culler hid during the pan.
 *
 * viewportCulledBlocks is the numerator; this adds the denominator (every
 * block on canvas), so a workspace that grows underneath the probe reads
 * differently from one whose culler stopped culling — the two failure
 * modes of #7738 that a raw count cannot tell apart.
 */
export class ViewportCulledFraction implements MetricPlugin {
  readonly name = "viewportCulledFraction";
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
    return {
      name: this.name,
      value: ps.viewportCulledFraction,
      meta: this.meta,
    };
  }
}
