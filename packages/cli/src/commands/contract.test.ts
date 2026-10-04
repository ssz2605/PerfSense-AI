import { describe, it, expect } from 'vitest';
import { buildContract } from './contract';
import { environmentsMatch, baselineAgeDays } from './env';
import type { BaselineData, EnvironmentFingerprint, PageResult } from '@perfsense/core';

function makeResults(): PageResult[] {
  return [
    {
      page: 'index.html',
      runs: Array.from({ length: 5 }, (_, i) => ({
        run: i + 1,
        metrics: { bootstrapTotal: 5000 + i, initTotal: 250 + i, heapAfterBoot: 47e6 },
      })),
    },
  ];
}

function makeBaseline(): BaselineData {
  return {
    schema: 'perfsense-baseline-v2',
    schemaVersion: 2,
    createdAt: '2026-09-15T00:00:00.000Z',
    generatedAt: '2026-09-15T00:00:00.000Z',
    runs: 5,
    pages: {
      'index.html': {
        bootstrapTotal: {
          median: 5000,
          p10: 4950,
          p90: 5050,
          mean: 5000,
          sd: 50,
          mad: 40,
          min: 4900,
          max: 5100,
          p25: 4975,
          p75: 5025,
          cv: 0.01,
          n: 5,
          invalid: 0,
          values: [4900, 4950, 5000, 5050, 5100],
          stability: { tier: 'stable', flagged: false },
        },
        // initTotal is approved for index.html in the matrix but the baseline
        // never captured it — it must surface as a missing-baseline hole
        // instead of vanishing.
      },
    },
    source: 'results.json',
  };
}

describe('buildContract', () => {
  it('counts expected/collected/valid/compared and surfaces baseline holes', () => {
    const contract = buildContract(makeResults(), makeBaseline());
    // Walks the matrix, so the count tracks the approved contract exactly:
    // 3 bootstrap + 4 Rainbow + 4 Frère + 4 musical-tree + 2 spiral + 2 crabcanon.
    expect(contract.expected).toBe(19);
    expect(contract.collected).toBeGreaterThanOrEqual(3);
    expect(contract.valid).toBeGreaterThanOrEqual(3);
    expect(contract.missing).toBeGreaterThan(0);
    expect(contract.compared).toBeGreaterThan(0);

    // initTotal is approved + collected on index.html, but the baseline lacks
    // it, so it is reported as a missing-baseline slot (not silently dropped).
    const initRow = contract.rows.find((r) => r.fixture === 'index.html' && r.metric === 'initTotal');
    expect(initRow).toBeDefined();
    expect(initRow!.baselineMissing).toBe(true);
    expect(initRow!.compared).toBe(false);
    expect(initRow!.skipped).toBe('no baseline');

    // bootstrapTotal has both baseline and current samples → compared.
    const bootRow = contract.rows.find((r) => r.fixture === 'index.html' && r.metric === 'bootstrapTotal');
    expect(bootRow!.compared).toBe(true);
  });
});

describe('env matching', () => {
  const base: EnvironmentFingerprint = {
    os: 'linux 6.8.0',
    arch: 'x64',
    node: 'v20.11.0',
    cpu: 'Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz',
    cores: 4,
    memoryGB: 16,
    coldState: true,
  };

  it('matches identical fingerprints and tolerates Node patch drift', () => {
    expect(environmentsMatch(base, base)).toBe(true);
    const patchDrift = { ...base, node: 'v20.19.2' };
    expect(environmentsMatch(base, patchDrift)).toBe(true);
    const majorDrift = { ...base, node: 'v22.4.0' };
    expect(environmentsMatch(base, majorDrift)).toBe(false);
    const cpuDrift = { ...base, cpu: 'Apple M3' };
    expect(environmentsMatch(base, cpuDrift)).toBe(false);
  });

  it('measures baseline freshness from generatedAt and falls back to createdAt', () => {
    const now = Date.parse('2026-09-21T00:00:00.000Z');
    const baseline = makeBaseline();
    expect(baselineAgeDays(baseline, now)).toBe(6);
    const v1 = { ...baseline, generatedAt: undefined, createdAt: '2026-08-01T00:00:00.000Z' };
    expect(baselineAgeDays(v1, now)).toBe(51);
  });
});