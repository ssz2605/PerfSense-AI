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

  it('shouldSkipBenchmark returns correct values', () => {
    const { shouldSkipBenchmark: fn } = require(path.join(rootDir, 'packages', 'cli', 'dist', 'commands', 'cache'));
    expect(fn(['README.md', 'CONTRIBUTING.md'])).toBe(true);
    expect(fn(['src/index.ts'])).toBe(false);
    expect(fn([])).toBe(true);
    expect(fn(['package.json'])).toBe(true);
  });
});
