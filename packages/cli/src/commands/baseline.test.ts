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
            // Required for #7703 and #7832. Save refuses to write a
            // baseline without them, so a capture that declares this page
            // must carry them.
            transportEventRatio: 0.0253,
            transportEventCount: 268,
            synthsRetained: 0,
          },
        })),
      },
      {
        page: 'crabcanon-plot.html',
        runs: Array.from({ length: 5 }, (_, i) => ({
          run: i + 1,
          metrics: {
            // Approved render cells (#7738/#7815).
            stageUpdateTime: 8.4 + i * 0.1,
            viewportCulledBlocks: 794 + i,
            viewportCulledFraction: 0.855,
            cacheRebuildCount: 243 + i,
            cacheSkippedCount: 656,
            // Retired as constant-on-unchanged-code; must be dropped at save time.
            scheduleLagMean: 12 + i,
            scheduleLagMax: 40 + i,
          },
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
    expect(baseline.schema).toBe('perfsense-baseline-v2');
    expect(baseline.schemaVersion).toBe(2);
    expect(baseline.runs).toBe(5);
    // v2 provenance + environment fingerprint.
    expect(baseline.generatedAt).toBeDefined();
    expect(baseline.env).toBeDefined();
    expect(baseline.env!.os).toBeDefined();
    expect(baseline.env!.arch).toBeDefined();
    expect(baseline.warmup).toBe(0);

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
      'synthsRetained',
      'transportEventCount',
      'transportEventRatio',
    ]);
    // scheduleLagMean/scheduleLagMax left the crabcanon contract and
    // stageUpdateTime/stageUpdateMax followed them, so all three are dropped
    // even though the raw run collected them.
    expect(Object.keys(baseline.pages['crabcanon-plot.html']).sort()).toEqual([
      'cacheRebuildCount',
      'cacheSkippedCount',
      'viewportCulledBlocks',
      'viewportCulledFraction',
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
            // Unauthorized for Rainbow (musical-tree owns memory coverage,
            // and the heap probes were retired from that contract too).
            memoryDelta: 1000 + i,
            // Approved: peak heap across the export pass, part of Rainbow's
            // export class.
            peakHeapDuringExport: FIVE_RUNS[i] + 400,
            // Required for #7923 and #7970; save refuses to write without them.
            refreshCanvasCallCount: 0,
            maxDepth: 100,
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
    // v2 distribution stats + stability tier on every approved metric.
    expect(stats.mean).toBe(1000);
    expect(stats.sd).toBeGreaterThan(0);
    expect(stats.mad).toBeGreaterThan(0);
    expect(stats.min).toBe(990);
    expect(stats.max).toBe(1010);
    expect(stats.cv).toBeLessThan(0.05);
    expect(stats.stability.tier).toBe('stable');
    expect(stats.stability.flagged).toBe(false);
    // The approved peak-heap export metric is kept like the other Rainbow metrics.
    const heapStats = baseline.pages['RainbowConnection.html'].peakHeapDuringExport;
    expect(heapStats.values).toHaveLength(5);
    expect(heapStats.median).toBe(1400);
    // memoryDelta is not approved for any fixture any more, so the decoy value
    // must be rejected at baseline-save time.
    expect(baseline.pages['RainbowConnection.html'].memoryDelta).toBeUndefined();
  });

  it('refuses to save when a required cell has no numeric sample', () => {
    // The regression this gate exists for: cacheRebuildCount and
    // viewportCulledBlocks were approved, required and collected, yet absent
    // from the v2 baseline because the save-time filter drops any metric with
    // no values. Save must now fail loudly instead of writing the hole.
    writeResults([
      {
        page: 'crabcanon-plot.html',
        runs: Array.from({ length: 5 }, (_, i) => ({
          run: i + 1,
          metrics: {
            cacheSkippedCount: 656,
            viewportCulledFraction: 0.855,
            // Both required cells read null on every run.
            cacheRebuildCount: null,
            viewportCulledBlocks: null,
          },
        })),
      },
    ]);

    const errors: string[] = [];
    const realError = console.error;
    console.error = (msg?: unknown) => {
      errors.push(String(msg ?? ''));
    };
    // Throw on exit, because a stub that merely returns would let execution run
    // past the gate and write the file the gate exists to prevent.
    class ExitCalled extends Error {
      constructor(readonly code: number) {
        super(`process.exit(${code})`);
      }
    }
    const realExit = process.exit;
    process.exit = ((code?: number) => {
      throw new ExitCalled(code ?? 0);
    }) as typeof process.exit;
    try {
      save(['--from', fromFile, '--out', outFile]);
      throw new Error('save() returned without exiting');
    } catch (err) {
      expect(err).toBeInstanceOf(ExitCalled);
      expect((err as ExitCalled).code).toBe(1);
    } finally {
      console.error = realError;
      process.exit = realExit;
    }

    // It must name every missing cell, not just the first.
    const said = errors.join('\n');
    expect(said).toContain('crabcanon-plot.html/cacheRebuildCount');
    expect(said).toContain('crabcanon-plot.html/viewportCulledBlocks');
    // And it must not leave a half-written baseline behind.
    expect(fs.existsSync(outFile)).toBe(false);
  });
});