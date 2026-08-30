import type { MetricPlugin } from '@perfsense/core';
import { TTFB } from './TTFB';
import { FCP } from './FCP';
import { LCP } from './LCP';

/**
 * Every metric the core package can measure, keyed by lowercase name so lookups
 * are case-insensitive. Shared by the benchmark, check, and report commands so
 * the set of known metrics lives in one place.
 */
export const CORE_PLUGIN_REGISTRY: Record<string, new () => MetricPlugin> = {
  ttfb: TTFB,
  fcp: FCP,
  lcp: LCP
};