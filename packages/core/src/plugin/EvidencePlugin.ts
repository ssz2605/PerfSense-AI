import type { Page } from 'playwright';

/**
 * Placeholder — not yet implemented.
 * Future: collects evidence (screenshots, traces, logs) for a run.
 */
export interface EvidencePlugin {
  readonly name: string;

  beforeRun(page: Page): Promise<void>;
  afterRun(page: Page, metrics: Record<string, number | null>): Promise<void>;
}
