import type { PageResult } from '@perfsense/core';
import { BENCHMARK_MATRIX } from '@perfsense/benchmark-matrix';

/**
 * Required fingerprint cells that did not produce a usable value.
 *
 * A fingerprint proves an optimization is still wired only if it was
 * actually measured. A collector that reads null on every run, a fixture
 * missing from the results, zero runs, or a timed-out run all produce
 * "no data" — which must never flow through the report as "no change".
 */
export interface RequiredFailure {
  fixture: string;
  metric: string;
  reason: string;
}

/**
 * Every approved fixture that carries a requiredMetrics list must show at
 * least one finite numeric sample per required metric. Returns one failure
 * per missing (fixture, metric) pair; an empty list means the capture is
 * complete enough to certify every seam it was supposed to certify.
 */
export function findRequiredFailures(
  current: PageResult[],
  expectedFixtures?: Iterable<string>,
): RequiredFailure[] {
  const failures: RequiredFailure[] = [];
  const byPage = new Map<string, PageResult>();
  for (const page of current) byPage.set(page.page.toLowerCase(), page);
  const expected = expectedFixtures
    ? new Set(Array.from(expectedFixtures, (fixture) => fixture.toLowerCase()))
    : null;

  for (const contract of BENCHMARK_MATRIX) {
    if (!contract.requiredMetrics || contract.requiredMetrics.length === 0) {
      continue;
    }
    // A report/check can deliberately compare a partial baseline (for example
    // a single-fixture investigation). Only insist on fixtures the baseline
    // says this capture is expected to contain. With no expectation supplied,
    // retain the whole-matrix validation used by direct contract checks.
    if (expected && !expected.has(contract.fixture.toLowerCase())) continue;
    const pageResult = byPage.get(contract.fixture.toLowerCase());
    if (!pageResult) {
      for (const metric of contract.requiredMetrics) {
        failures.push({
          fixture: contract.fixture,
          metric,
          reason: 'fixture missing from results (no runs completed)',
        });
      }
      continue;
    }
    if (!pageResult.runs || pageResult.runs.length === 0) {
      for (const metric of contract.requiredMetrics) {
        failures.push({
          fixture: contract.fixture,
          metric,
          reason: 'fixture has zero completed runs',
        });
      }
      continue;
    }
    for (const metric of contract.requiredMetrics) {
      const key = metric.toLowerCase();
      const hasSample = pageResult.runs.some((run) =>
        Object.entries(run.metrics ?? {}).some(
          ([k, v]) => k.toLowerCase() === key && typeof v === 'number' && Number.isFinite(v),
        ),
      );
      if (!hasSample) {
        failures.push({
          fixture: contract.fixture,
          metric,
          reason: 'null on every run (collector broken or run timed out)',
        });
      }
    }
  }
  return failures;
}
