import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

const rootDir = path.resolve(__dirname, "..");
const examplesDir = path.join(rootDir, "examples", "music-blocks");

describe("GitHub Action E2E", () => {
  it("simulates full CI pipeline: benchmark → check → report", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "perfsense-e2e-"));
    try {
      // Copy pages to temp dir
      const pagesDir = path.join(workDir, "pages");
      fs.cpSync(path.join(examplesDir, "pages"), pagesDir, { recursive: true });

      // Create config with correct relative paths (use fewer runs for speed)
      const config = {
        pages: ["pages/fast-project.html"],
        runs: 3,
        port: 8934,
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
        metrics: [
          "ttfb",
          "fcp",
          "lcp",
          "playbackLatency",
          "audioDrift",
          "stageUpdateTime",
          "blockThroughput",
          "projectLoadTime",
        ],
      };
      const configPath = path.join(workDir, "perfsense.config.json");
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Step 1: Benchmark the fast project as baseline
      execSync(
        `node "${path.join(rootDir, "packages", "cli", "dist", "index.js")}" benchmark --config "${configPath}" --out "${path.join(workDir, "results.json")}"`,
        { cwd: workDir, stdio: "pipe", timeout: 60000 },
      );

      const resultsPath = path.join(workDir, "results.json");
      expect(fs.existsSync(resultsPath)).toBe(true);
      const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
      expect(results).toBeInstanceOf(Array);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toHaveProperty("runs");

      // Step 2: Save baseline
      execSync(
        `node "${path.join(rootDir, "packages", "cli", "dist", "index.js")}" baseline save --from "${resultsPath}" --out "${path.join(workDir, "baseline.json")}"`,
        { cwd: workDir, stdio: "pipe" },
      );

      const baselinePath = path.join(workDir, "baseline.json");
      expect(fs.existsSync(baselinePath)).toBe(true);

      // Step 3: Run check with statistical mode
      const checkOutput = execSync(
        `node "${path.join(rootDir, "packages", "cli", "dist", "index.js")}" check --baseline "${baselinePath}" --current "${resultsPath}" --config "${configPath}" --statistical --format json`,
        { cwd: workDir, encoding: "utf-8", timeout: 30000 },
      );

      const checkResult = JSON.parse(checkOutput.trim());
      expect(checkResult).toHaveProperty("results");
      expect(checkResult).toHaveProperty("summary");

      // Step 4: Run report command
      const reportOutput = execSync(
        `node "${path.join(rootDir, "packages", "cli", "dist", "index.js")}" report --baseline "${baselinePath}" --current "${resultsPath}" --config "${configPath}" --repository "${workDir}" --source-maps "${workDir}"`,
        { cwd: workDir, encoding: "utf-8", timeout: 30000 },
      );

      // Assert output contains PR comment structure.
      // The synthetic e2e page is not part of the approved Music Blocks
      // Benchmark Matrix, so the contract-filtered report renders the summary
      // sections without leaking its raw metrics.
      expect(reportOutput).toContain("PerfSense Performance Report");
      expect(reportOutput).toContain("Fixture summary");
      expect(reportOutput).toContain("🟢 No significant regression");
      expect(reportOutput).toContain("No benchmark results match the approved Benchmark Matrix.");
      expect(reportOutput).toContain("No regressions or meaningful improvements detected.");
      expect(reportOutput).toContain("Artifacts");

      // Step 5: Test cache command
      const cacheOutput = execSync(
        `node "${path.join(rootDir, "packages", "cli", "dist", "index.js")}" cache --changed-files "README.md,CONTRIBUTING.md"`,
        { cwd: workDir, encoding: "utf-8" },
      );
      expect(cacheOutput.trim()).toContain(
        "No performance-relevant changes detected",
      );

      // Step 6: Cache with bundle files should detect changes
      const cacheOutput2 = execSync(
        `node "${path.join(rootDir, "packages", "cli", "dist", "index.js")}" cache --changed-files "src/index.ts,README.md"`,
        { cwd: workDir, encoding: "utf-8" },
      );
      expect(cacheOutput2.trim()).toContain(
        "Performance-relevant changes detected",
      );
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // Retry after a short delay (handle Windows file locks)
        setTimeout(() => {
          try {
            fs.rmSync(workDir, { recursive: true, force: true });
          } catch {}
        }, 1000);
      }
    }
  }, 120000);

  it("collects approved audio metrics and rejects unauthorized ones at the driver", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "perfsense-seams-"));
    try {
      const pagesDir = path.join(workDir, "pages");
      fs.cpSync(path.join(examplesDir, "pages"), pagesDir, { recursive: true });
      // Serve the mock under a Benchmark Matrix fixture name so the contract
      // approves its audio metrics and rejects the execution metrics.
      fs.copyFileSync(
        path.join(pagesDir, "fast-project.html"),
        path.join(pagesDir, "Frere-Jacques.html"),
      );

      const config = {
        pages: ["pages/Frere-Jacques.html"],
        runs: 3,
        port: 8935,
        scenario: "playToCompletion",
        metrics: [
          "ttfb",
          "callbackLatencyMean",
          "callbackLatencyMax",
          "cumulativeDrift",
          "voiceOnsetError",
          "executionTime",
          "maxQueueDepth",
          "blocksExecuted",
          "maxDepth",
          "memoryDelta",
          "retainedHeap",
        ],
      };
      const configPath = path.join(workDir, "perfsense.config.json");
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      execSync(
        `node "${path.join(rootDir, "packages", "cli", "dist", "index.js")}" benchmark --config "${configPath}" --out "${path.join(workDir, "results.json")}"`,
        { cwd: workDir, stdio: "pipe", timeout: 120000 },
      );

      const results = JSON.parse(
        fs.readFileSync(path.join(workDir, "results.json"), "utf-8"),
      );
      expect(results).toBeInstanceOf(Array);
      expect(results[0]).toHaveProperty("runs");
      expect(results[0].runs.length).toBe(3);

      const run0 = results[0].runs[0].metrics;
      // Approved for Frère Jacques: the audio-seam metrics flow through.
      expect(run0.callbackLatencyMean).toBeTypeOf("number");
      expect(run0.callbackLatencyMax).toBeTypeOf("number");
      expect(run0.cumulativeDrift).toBeTypeOf("number");
      expect(run0.voiceOnsetError).toBeTypeOf("number");
      // Unauthorized for Frère Jacques: rejected at collection, never raw data.
      expect(run0.executionTime).toBeUndefined();
      expect(run0.maxQueueDepth).toBeUndefined();
      expect(run0.blocksExecuted).toBeUndefined();
      expect(run0.maxDepth).toBeUndefined();
      expect(run0.memoryDelta).toBeUndefined();
      expect(run0.retainedHeap).toBeUndefined();
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        setTimeout(() => {
          try {
            fs.rmSync(workDir, { recursive: true, force: true });
          } catch {}
        }, 1000);
      }
    }
  }, 120000);

  it("records bootstrap and open-project scenario metrics", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "perfsense-boot-"));
    try {
      const pagesDir = path.join(workDir, "pages");
      fs.cpSync(path.join(examplesDir, "pages"), pagesDir, { recursive: true });
      // bootstrapTotal/initTotal/heapAfterBoot are approved only for index.html.
      fs.copyFileSync(
        path.join(pagesDir, "fast-project.html"),
        path.join(pagesDir, "index.html"),
      );

      const config = {
        pages: ["pages/index.html"],
        runs: 2,
        port: 8936,
        scenario: "bootstrap",
        metrics: ["ttfb", "bootstrapTotal", "initTotal", "heapAfterBoot"],
      };
      const configPath = path.join(workDir, "perfsense.config.json");
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      execSync(
        `node "${path.join(rootDir, "packages", "cli", "dist", "index.js")}" benchmark --config "${configPath}" --out "${path.join(workDir, "results.json")}"`,
        { cwd: workDir, stdio: "pipe", timeout: 60000 },
      );

      const results = JSON.parse(
        fs.readFileSync(path.join(workDir, "results.json"), "utf-8"),
      );
      const run0 = results[0].runs[0].metrics;
      expect(run0.bootstrapTotal).toBe(22);
      expect(run0.initTotal).toBe(583);
      expect(run0.heapAfterBoot).toBeTypeOf("number");
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        setTimeout(() => {
          try {
            fs.rmSync(workDir, { recursive: true, force: true });
          } catch {}
        }, 1000);
      }
    }
  }, 60000);

  it("runs per-page composite scenarios through the phases engine", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "perfsense-phases-"));
    try {
      const pagesDir = path.join(workDir, "pages");
      fs.cpSync(path.join(examplesDir, "pages"), pagesDir, { recursive: true });
      // Serve the mock under a Benchmark Matrix fixture name; musical-tree
      // approves execution metrics but not the project/save phase metrics.
      fs.copyFileSync(
        path.join(pagesDir, "fast-project.html"),
        path.join(pagesDir, "musical-tree.html"),
      );

      // A real fixture file so openProject has something to read.
      const fixturePath = path.join(pagesDir, "sample-project.html");
      fs.writeFileSync(fixturePath, "<html><body>sample project</body></html>");

      const config = {
        pages: ["pages/musical-tree.html"],
        runs: 2,
        port: 8937,
        scenarios: {
          "musical-tree.html": [
            "openProject",
            "playToCompletion",
            "saveExport",
          ],
        },
        fixtures: { "musical-tree.html": fixturePath },
        metrics: [
          "projectLoadTime",
          "executionTime",
          "saveTime",
          "exportMIDITime",
          "blocksExecuted",
          "maxQueueDepth",
          "memoryDelta",
          "retainedHeap",
          "maxDepth",
        ],
      };
      const configPath = path.join(workDir, "perfsense.config.json");
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      execSync(
        `node "${path.join(rootDir, "packages", "cli", "dist", "index.js")}" benchmark --config "${configPath}" --out "${path.join(workDir, "results.json")}"`,
        { cwd: workDir, stdio: "pipe", timeout: 120000 },
      );

      const results = JSON.parse(
        fs.readFileSync(path.join(workDir, "results.json"), "utf-8"),
      );
      expect(results[0].runs.length).toBe(2);

      const run0 = results[0].runs[0].metrics;
      // All three phases ran on the page; musical-tree approved metrics flowed.
      expect(run0.executionTime).toBeTypeOf("number");
      expect(run0.maxQueueDepth).toBeTypeOf("number");
      expect(run0.maxDepth).toBeGreaterThan(0);
      expect(run0.memoryDelta).toBeDefined();
      expect(run0.retainedHeap).toBeDefined();
      // Phase metrics not approved for musical-tree were rejected at collection.
      expect(run0.projectLoadTime).toBeUndefined();
      expect(run0.saveTime).toBeUndefined();
      expect(run0.exportMIDITime).toBeUndefined();
      expect(run0.blocksExecuted).toBeUndefined();
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        setTimeout(() => {
          try {
            fs.rmSync(workDir, { recursive: true, force: true });
          } catch {}
        }, 1000);
      }
    }
  }, 120000);

  it("collects scheduleLagMean/Max for the crabcanon fixture", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "perfsense-lag-"));
    try {
      const pagesDir = path.join(workDir, "pages");
      fs.cpSync(path.join(examplesDir, "pages"), pagesDir, { recursive: true });
      // scheduleLagMean/scheduleLagMax are approved only for crabcanon-plot.
      fs.copyFileSync(
        path.join(pagesDir, "fast-project.html"),
        path.join(pagesDir, "crabcanon-plot.html"),
      );

      const config = {
        pages: ["pages/crabcanon-plot.html"],
        runs: 2,
        port: 8938,
        scenario: "playToCompletion",
        metrics: ["scheduleLagMean", "scheduleLagMax", "callbackLatencyMean"],
      };
      const configPath = path.join(workDir, "perfsense.config.json");
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      execSync(
        `node "${path.join(rootDir, "packages", "cli", "dist", "index.js")}" benchmark --config "${configPath}" --out "${path.join(workDir, "results.json")}"`,
        { cwd: workDir, stdio: "pipe", timeout: 60000 },
      );

      const results = JSON.parse(
        fs.readFileSync(path.join(workDir, "results.json"), "utf-8"),
      );
      const run0 = results[0].runs[0].metrics;
      expect(run0.scheduleLagMean).toBeTypeOf("number");
      expect(run0.scheduleLagMax).toBeTypeOf("number");
      // Not approved for crabcanon: rejected at the driver.
      expect(run0.callbackLatencyMean).toBeUndefined();
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        setTimeout(() => {
          try {
            fs.rmSync(workDir, { recursive: true, force: true });
          } catch {}
        }, 1000);
      }
    }
  }, 60000);

  it("shouldSkipBenchmark returns correct values", () => {
    const { shouldSkipBenchmark: fn } = require(
      path.join(rootDir, "packages", "cli", "dist", "commands", "cache"),
    );
    expect(fn(["README.md", "CONTRIBUTING.md"])).toBe(true);
    expect(fn(["src/index.ts"])).toBe(false);
    expect(fn([])).toBe(true);
    expect(fn(["package.json"])).toBe(true);
  });
});
