import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const rootDir = path.resolve(__dirname, '..');
const examplesDir = path.join(rootDir, 'examples', 'music-blocks');

describe('GitHub Action E2E', () => {
  it('simulates full CI pipeline: benchmark → check → report', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perfsense-e2e-'));
    try {
      // Copy pages to temp dir
      const pagesDir = path.join(workDir, 'pages');
      fs.cpSync(path.join(examplesDir, 'pages'), pagesDir, { recursive: true });

      // Create config with correct relative paths (use fewer runs for speed)
      const config = {
        pages: ['pages/fast-project.html'],
        runs: 3,
        thresholds: {
          playbackLatency: { warning: 20, fail: 50 },
          audioDrift: { warning: 15, fail: 30 },
          stageUpdateTime: { warning: 10, fail: 25 },
          blockThroughput: { warning: 10, fail: 20 },
          projectLoadTime: { warning: 15, fail: 30 },
          TTFB: { warning: 10, fail: 30 },
          FCP: { warning: 5, fail: 10 },
          LCP: { warning: 5, fail: 10 },
        },
        metrics: ['ttfb', 'fcp', 'lcp', 'playbackLatency', 'audioDrift', 'stageUpdateTime', 'blockThroughput', 'projectLoadTime'],
      };
      const configPath = path.join(workDir, 'perfsense.config.json');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Step 1: Benchmark the fast project as baseline
      execSync(
        `node "${path.join(rootDir, 'packages', 'cli', 'dist', 'index.js')}" benchmark --config "${configPath}" --out "${path.join(workDir, 'results.json')}"`,
        { cwd: workDir, stdio: 'pipe', timeout: 60000 },
      );

      const resultsPath = path.join(workDir, 'results.json');
      expect(fs.existsSync(resultsPath)).toBe(true);
      const results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
      expect(results).toBeInstanceOf(Array);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty('runs');

      // Step 2: Save baseline
      execSync(
        `node "${path.join(rootDir, 'packages', 'cli', 'dist', 'index.js')}" baseline save --from "${resultsPath}" --out "${path.join(workDir, 'baseline.json')}"`,
        { cwd: workDir, stdio: 'pipe' },
      );

      const baselinePath = path.join(workDir, 'baseline.json');
      expect(fs.existsSync(baselinePath)).toBe(true);

      // Step 3: Run check with statistical mode
      const checkOutput = execSync(
        `node "${path.join(rootDir, 'packages', 'cli', 'dist', 'index.js')}" check --baseline "${baselinePath}" --current "${resultsPath}" --config "${configPath}" --statistical --format json`,
        { cwd: workDir, encoding: 'utf-8', timeout: 30000 },
      );

      const checkResult = JSON.parse(checkOutput.trim());
      expect(checkResult).toHaveProperty('results');
      expect(checkResult).toHaveProperty('summary');

      // Step 4: Run report command
      const reportOutput = execSync(
        `node "${path.join(rootDir, 'packages', 'cli', 'dist', 'index.js')}" report --baseline "${baselinePath}" --current "${resultsPath}" --config "${configPath}" --repository "${workDir}" --source-maps "${workDir}"`,
        { cwd: workDir, encoding: 'utf-8', timeout: 30000 },
      );

      // Assert output contains PR comment structure
      expect(reportOutput).toContain('PerfSense AI');
      expect(reportOutput).toContain('Summary');
      expect(reportOutput).toContain('Baseline');
      expect(reportOutput).toContain('Current');

      // Step 5: Test cache command
      const cacheOutput = execSync(
        `node "${path.join(rootDir, 'packages', 'cli', 'dist', 'index.js')}" cache --changed-files "README.md,CONTRIBUTING.md"`,
        { cwd: workDir, encoding: 'utf-8' },
      );
      expect(cacheOutput.trim()).toContain('No performance-relevant changes detected');

      // Step 6: Cache with bundle files should detect changes
      const cacheOutput2 = execSync(
        `node "${path.join(rootDir, 'packages', 'cli', 'dist', 'index.js')}" cache --changed-files "src/index.ts,README.md"`,
        { cwd: workDir, encoding: 'utf-8' },
      );
      expect(cacheOutput2.trim()).toContain('Performance-relevant changes detected');
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); }
      catch {
        // Retry after a short delay (handle Windows file locks)
        setTimeout(() => {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
        }, 1000);
      }
    }
  }, 120000);

  it('records real music-blocks seam metrics through scenarios', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perfsense-seams-'));
    try {
      const pagesDir = path.join(workDir, 'pages');
      fs.cpSync(path.join(examplesDir, 'pages'), pagesDir, { recursive: true });

      const config = {
        pages: ['pages/fast-project.html'],
        runs: 3,
        scenario: 'playToCompletion',
        metrics: [
          'ttfb', 'callbackLatencyMean', 'callbackLatencyMax', 'cumulativeDrift',
          'voiceOnsetError', 'executionTime', 'maxQueueDepth', 'blocksExecuted',
          'maxDepth', 'memoryDelta', 'retainedHeap'
        ],
      };
      const configPath = path.join(workDir, 'perfsense.config.json');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      execSync(
        `node "${path.join(rootDir, 'packages', 'cli', 'dist', 'index.js')}" benchmark --config "${configPath}" --out "${path.join(workDir, 'results.json')}"`,
        { cwd: workDir, stdio: 'pipe', timeout: 120000 },
      );

      const results = JSON.parse(fs.readFileSync(path.join(workDir, 'results.json'), 'utf-8'));
      expect(results).toBeInstanceOf(Array);
      expect(results[0]).toHaveProperty('runs');
      expect(results[0].runs.length).toBe(3);

      const run0 = results[0].runs[0].metrics;
      expect(run0.callbackLatencyMean).toBeTypeOf('number');
      expect(run0.callbackLatencyMax).toBeTypeOf('number');
      expect(run0.cumulativeDrift).toBeTypeOf('number');
      expect(run0.voiceOnsetError).toBeTypeOf('number');
      expect(run0.executionTime).toBeTypeOf('number');
      expect(run0.maxQueueDepth).toBeTypeOf('number');
      expect(run0.blocksExecuted).toBeGreaterThan(0);
      expect(run0.maxDepth).toBeGreaterThan(0);
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); }
      catch {
        setTimeout(() => {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
        }, 1000);
      }
    }
  }, 120000);

  it('records bootstrap and open-project scenario metrics', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perfsense-boot-'));
    try {
      const pagesDir = path.join(workDir, 'pages');
      fs.cpSync(path.join(examplesDir, 'pages'), pagesDir, { recursive: true });

      const config = {
        pages: ['pages/fast-project.html'],
        runs: 2,
        scenario: 'bootstrap',
        metrics: ['ttfb', 'bootstrapTotal', 'initTotal', 'heapAfterBoot'],
      };
      const configPath = path.join(workDir, 'perfsense.config.json');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      execSync(
        `node "${path.join(rootDir, 'packages', 'cli', 'dist', 'index.js')}" benchmark --config "${configPath}" --out "${path.join(workDir, 'results.json')}"`,
        { cwd: workDir, stdio: 'pipe', timeout: 60000 },
      );

      const results = JSON.parse(fs.readFileSync(path.join(workDir, 'results.json'), 'utf-8'));
      const run0 = results[0].runs[0].metrics;
      expect(run0.bootstrapTotal).toBe(22);
      expect(run0.initTotal).toBe(583);
      expect(run0.heapAfterBoot).toBeTypeOf('number');
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); }
      catch {
        setTimeout(() => {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
        }, 1000);
      }
    }
  }, 60000);

  it('runs per-page composite scenarios through the phases engine', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perfsense-phases-'));
    try {
      const pagesDir = path.join(workDir, 'pages');
      fs.cpSync(path.join(examplesDir, 'pages'), pagesDir, { recursive: true });

      // A real fixture file so openProject has something to read.
      const fixturePath = path.join(pagesDir, 'sample-project.html');
      fs.writeFileSync(fixturePath, '<html><body>sample project</body></html>');

      const config = {
        pages: ['pages/fast-project.html'],
        runs: 2,
        scenarios: { 'fast-project.html': ['openProject', 'playToCompletion', 'saveExport'] },
        fixtures: { 'fast-project.html': fixturePath },
        metrics: ['projectLoadTime', 'executionTime', 'saveTime', 'exportMIDITime', 'blocksExecuted', 'maxQueueDepth'],
      };
      const configPath = path.join(workDir, 'perfsense.config.json');
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      execSync(
        `node "${path.join(rootDir, 'packages', 'cli', 'dist', 'index.js')}" benchmark --config "${configPath}" --out "${path.join(workDir, 'results.json')}"`,
        { cwd: workDir, stdio: 'pipe', timeout: 120000 },
      );

      const results = JSON.parse(fs.readFileSync(path.join(workDir, 'results.json'), 'utf-8'));
      expect(results[0].runs.length).toBe(2);

      const run0 = results[0].runs[0].metrics;
      expect(run0.projectLoadTime).toBeTypeOf('number');
      expect(run0.executionTime).toBeTypeOf('number');
      expect(run0.saveTime).toBeTypeOf('number');
      expect(run0.exportMIDITime).toBeTypeOf('number');
      expect(run0.blocksExecuted).toBeGreaterThan(0);
      expect(run0.maxQueueDepth).toBeTypeOf('number');
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); }
      catch {
        setTimeout(() => {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
        }, 1000);
      }
    }
  }, 120000);

  it('shouldSkipBenchmark returns correct values', () => {
    const { shouldSkipBenchmark: fn } = require(path.join(rootDir, 'packages', 'cli', 'dist', 'commands', 'cache'));
    expect(fn(['README.md', 'CONTRIBUTING.md'])).toBe(true);
    expect(fn(['src/index.ts'])).toBe(false);
    expect(fn([])).toBe(true);
    expect(fn(['package.json'])).toBe(true);
  });
});
