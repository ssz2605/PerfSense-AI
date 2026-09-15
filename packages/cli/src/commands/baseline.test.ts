import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { save } from './baseline';
import type { PageResult, BaselineData } from '@perfsense/core';

let tmpDir: string;
let fromFile: string;
let outFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perfsense-baseline-'));
  fromFile = path.join(tmpDir, 'results.json');
  outFile = path.join(tmpDir, 'baseline.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeResults(results: PageResult[]): void {
  fs.writeFileSync(fromFile, JSON.stringify(results));
}

const FIVE_RUNS = [1000, 1010, 990, 1005, 995];

describe('baseline save contract', () => {
  it('keeps only approved fixture/metric combinations from raw results', () => {
    writeResults([
      {
        page: 'index.html',
        runs: Array.from({ length: 5 }, (_, i) => ({
          run: i + 1,
          metrics: { bootstrapTotal: FIVE_RUNS[i], initTotal: 300 + i, heapAfterBoot: 47e6, memoryDelta: 42 },
        })),
      },
      {
        page: 'Frere-Jacques.html',
        runs: Array.from({ length: 5 }, (_, i) => ({
          run: i + 1,
          metrics: {
            callbackLatencyMean: 700 + i,
            callbackLatencyMax: 2600 + i,
            // Violations that must be dropped at baseline-save time.
            executionTime: 60000 + i,
            maxActionDepth: 25,
            projectLoadTime: 1800 + i,
          },
        })),
      },
      {
        page: 'crabcanon-plot.html',
        runs: Array.from({ length: 5 }, (_, i) => ({
          run: i + 1,
          metrics: { scheduleLagMean: 12 + i, scheduleLagMax: 40 + i },
        })),
      },
      {
        // Whole page outside the matrix must be dropped.
        page: 'unknown-page.html',
        runs: Array.from({ length: 5 }, (_, i) => ({
          run: i + 1,
          metrics: { someMetric: i },
        })),
      },
    ]);

    save(['--from', fromFile, '--out', outFile]);

    const baseline: BaselineData = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    expect(baseline.schema).toBe('perfsense-baseline-v1');
    expect(baseline.runs).toBe(5);

    // Page keys match the matrix exactly.
    expect(Object.keys(baseline.pages).sort()).toEqual([
      'Frere-Jacques.html',
      'crabcanon-plot.html',
      'index.html',
    ]);

    // Unauthorized metrics are removed from an approved page.
    expect(Object.keys(baseline.pages['index.html']).sort()).toEqual([
      'bootstrapTotal',
      'heapAfterBoot',
      'initTotal',
    ]);
    expect(Object.keys(baseline.pages['Frere-Jacques.html']).sort()).toEqual([
      'callbackLatencyMax',
      'callbackLatencyMean',
    ]);
    expect(Object.keys(baseline.pages['crabcanon-plot.html']).sort()).toEqual([
      'scheduleLagMax',
      'scheduleLagMean',
    ]);
    // maxActionDepth never appears in the baseline.
    expect(JSON.stringify(baseline)).not.toContain('maxActionDepth');
  });

  it('keeps sample arrays for median/p10/p90 of approved metrics', () => {
    writeResults([
      {
        page: 'RainbowConnection.html',
        runs: Array.from({ length: 5 }, (_, i) => ({
          run: i + 1,
          metrics: {
            projectLoadTime: FIVE_RUNS[i],
            // Unauthorized for Rainbow (musical-tree owns memory coverage).
            memoryDelta: 1000 + i,
            // Approved: LilyPond notation export, part of Rainbow's export class.
            saveAsLilypondTime: FIVE_RUNS[i] + 400,
          },
        })),
      },
    ]);

    save(['--from', fromFile, '--out', outFile]);

    const baseline: BaselineData = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    const stats = baseline.pages['RainbowConnection.html'].projectLoadTime;
    expect(stats.values).toHaveLength(5);
    expect(stats.median).toBe(1000); // median of [990,995,1000,1005,1010]
    expect(stats.p10).toBeLessThanOrEqual(1000);
    expect(stats.p90).toBeGreaterThanOrEqual(1005);
    // The approved LilyPond export metric is kept like the other Rainbow metrics.
    const lilypondStats = baseline.pages['RainbowConnection.html'].saveAsLilypondTime;
    expect(lilypondStats.values).toHaveLength(5);
    expect(lilypondStats.median).toBe(1400);
    // memoryDelta is not approved for Rainbow (musical-tree owns the memory
    // metrics), so the decoy value must be rejected at baseline-save time.
    expect(baseline.pages['RainbowConnection.html'].memoryDelta).toBeUndefined();
  });
});