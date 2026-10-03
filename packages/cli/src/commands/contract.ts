import type { BaselineData, ContractRow, ContractSummary, PageResult } from '@perfsense/core';
import { MIN_RUNS } from '@perfsense/statistics';
import { BENCHMARK_MATRIX, getFixtureContract, isMetricApproved } from '@perfsense/benchmark-matrix';

function collectValues(pageResult: PageResult, metric: string): number[] {
  return pageResult.runs
    .map((r) => r.metrics[metric])
    .filter((v): v is number => typeof v === 'number');
}

/**
 * Builds the metric-coverage contract for a run. Walks the matrix (the source
 * of truth), not the raw results, so every approved metric is accounted for —
 * including ones the PR run never emitted and ones the baseline never captured.
 */
export function buildContract(current: PageResult[], baseline: BaselineData): ContractSummary {
  const rows: ContractRow[] = [];
  const currentByFixture = new Map<string, PageResult>();
  for (const page of current) {
    // Case-insensitive fixture matching, mirroring the matrix helpers.
    if (!currentByFixture.has(page.page.toLowerCase())) {
      currentByFixture.set(page.page.toLowerCase(), page);
    }
  }

  for (const contract of BENCHMARK_MATRIX) {
    const fixture = contract.fixture;
    const pageResult = currentByFixture.get(fixture.toLowerCase());
    for (const metric of contract.metrics) {
      const collected = pageResult !== undefined && collectValues(pageResult, metric).length > 0;
      const valid = collected && collectValues(pageResult!, metric).length >= MIN_RUNS;
      const baselineMissing = !baseline.pages[fixture] || !baseline.pages[fixture][metric];
      let compared = false;
      let skipped: string | null = null;
      if (!expectedFor(fixture, metric)) skipped = 'not in matrix';
      else if (!collected) skipped = 'no current samples';
      else if (baselineMissing) skipped = 'no baseline';
      else if (!valid) skipped = 'insufficient valid runs';
      else compared = true;

      rows.push({
        fixture,
        metric,
        expected: true,
        collected,
        valid,
        baselineMissing,
        compared,
        skipped,
      });
    }
  }

  return summarizeContract(rows);
}

function expectedFor(fixture: string, metric: string): boolean {
  return isMetricApproved(fixture, metric);
}

export function summarizeContract(rows: ContractRow[]): ContractSummary {
  return {
    rows,
    expected: rows.filter((r) => r.expected).length,
    collected: rows.filter((r) => r.collected).length,
    valid: rows.filter((r) => r.valid).length,
    missing: rows.filter((r) => r.expected && r.baselineMissing).length,
    skipped: rows.filter((r) => r.expected && r.skipped !== null && !r.baselineMissing).length,
    compared: rows.filter((r) => r.compared).length,
  };
}

/** Convenience for the report: true when a metric exists in the matrix. */
export function matrixFixture(fixture: string): boolean {
  return getFixtureContract(fixture) !== undefined;
}