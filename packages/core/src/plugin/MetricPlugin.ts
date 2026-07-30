import type { Page } from 'playwright';
import type { MetricMeta, MetricValue } from '../types';

export interface MetricPlugin {
  readonly name: string;
  readonly meta: MetricMeta;

  /** Called before navigation. Inject init scripts, register observers, etc. */
  setupPage(page: Page): Promise<void>;

  /** Called after page.goto() and before the settle wait. Optional. */
  setupPostNav?(page: Page): Promise<void>;

  /** Called after the page has settled. Extract the metric value. */
  extractMetric(page: Page): Promise<MetricValue>;

  /** Names of other plugins that must be evaluated before this one. */
  readonly dependencies?: string[];
}
