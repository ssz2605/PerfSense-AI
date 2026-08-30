import type { Page } from 'playwright';
import type { MetricPlugin, MetricMeta, MetricValue } from '@perfsense/core';
import { readPerfsense } from './runtime';

const meta: MetricMeta = { unit: 'ms', lowerIsBetter: true, type: 'duration' };
const PROJECT_DATA = JSON.stringify({ blocks: [{ id: 1 }, { id: 2 }, { id: 3 }] });

export class ProjectLoadTime implements MetricPlugin {
  readonly name = 'projectLoadTime';
  readonly meta = meta;

  async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      (window as any).__perfsense = (window as any).__perfsense || {};
    });
  }

  async setupPostNav(page: Page): Promise<void> {
    // Prefer the value recorded by the `openProject` scenario (real fixture
    // loaded through the app's file-open path). If the page does not record
    // it, fall back to the synthetic load for mock-only benchmark setups.
    const scenarioValue = await readPerfsense(page);
    if (scenarioValue.projectLoadTime !== null && scenarioValue.projectLoadTime !== undefined) {
      return;
    }
    await page.evaluate(({ data }: { data: string }) => {
      const mb = (window as any).__mb;
      if (!mb || typeof mb.loadProject !== 'function') return;

      const start = performance.now();
      return new Promise<void>((resolve) => {
        mb.loadProject(data, function () {
          (window as any).__perfsense.projectLoadTime = performance.now() - start;
          resolve();
        });
      });
    }, { data: PROJECT_DATA });
  }

  async extractMetric(page: Page): Promise<MetricValue> {
    const val = await page.evaluate(() => {
      const p = (window as any).__perfsense;
      return p?.projectLoadTime ?? null;
    });
    return { name: this.name, value: val, meta: this.meta };
  }
}
