import http from "http";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type {
  MetricPlugin,
  BenchmarkConfig,
  BenchmarkRun,
  PageResult,
} from "@perfsense/core";
import { runScenario, isScenario, Scenario, callWithArg } from "./scenarios";
import type { ScenarioName } from "./scenarios";
import { isMetricApproved } from "@perfsense/benchmark-matrix";

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function pageNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const proj = u.searchParams.get("perfsenseProject");
    if (proj) {
      const seg = proj.split("/").filter(Boolean).pop();
      if (seg) return seg;
    }
    return u.pathname.split("/").filter(Boolean).pop() || "index";
  } catch {
    return url;
  }
}

const RUN_TIMEOUT_MS = 120000;

/**
 * Ordered interaction phases for a page. The per-page `scenarios` map wins when
 * it names that page; otherwise a single global scenario applies. Unknown phase
 * names are filtered out so bad config degrades to a no-op run, not a crash.
 */
function stagePhases(
  scenariosForPage: string[] | undefined,
  globalScenario: string | undefined,
): ScenarioName[] {
  if (scenariosForPage && scenariosForPage.length > 0) {
    return scenariosForPage.filter(isScenario);
  }
  if (globalScenario && isScenario(globalScenario)) {
    return [globalScenario];
  }
  return [];
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`run exceeded ${ms}ms timeout, skipping`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The wall-clock budget for one page: its own `runTimeouts` entry, else the
 * global `runTimeoutMs`, else the built-in default.
 *
 * The precedence is the whole point and is easy to get wrong by accident.
 * musical-tree runs its program twelve times (twice inside playToCompletion,
 * then `repeatRuns`), which measures ~289s of scenario work against a 300s
 * global budget, so every run was being discarded as a timeout. Raising the
 * global figure would hand that slack to every other page as well, where it
 * could only mask a genuine hang.
 *
 * Exported for the same reason `openProjectGateSnippet` is: a rule that
 * decides whether a run is measured at all should not be verifiable only by
 * spending 20 minutes on a capture.
 */
export function resolveRunTimeout(
  config: Pick<BenchmarkConfig, "runTimeoutMs" | "runTimeouts">,
  pageName: string,
): number {
  return config.runTimeouts?.[pageName] ?? config.runTimeoutMs ?? RUN_TIMEOUT_MS;
}

/**
 * Readiness gate for the open-project phase, as a page-evaluated snippet.
 *
 * Exported for the same reason `openProjectSnippet` is: it is the only thing
 * standing between the fixture drop and a silently swallowed change event, and
 * a rule that load-bearing should not be verifiable only by a full capture.
 *
 * The mock rule is the load-bearing part. The mock bridge
 * (examples/music-blocks/pages/fast-project.html) has `ui` but no `blocks`: it
 * fakes the workspace by writing DOM into #blocks. The real bridge assigns its
 * properties one at a time (js/activity.js:2865-2896) and sets `blocks` before
 * `ui`, so `ui` without `blocks` is unreachable there -- which is what makes
 * the rule sound rather than a guess. Testing `ui` alone used to classify the
 * REAL app as a mock, because setupPostNav's waitForStageBridge had already
 * made the bridge appear before this gate ran -- which then took the
 * `bridged || booted` branch, skipped waiting for `bridged`, and disabled the
 * phantom-load guard, on the very pages that need it.
 */
export const openProjectGateSnippet = `
(function (timeoutMs) {
  var start = Date.now();
  var mb0 = (window).__mb;
  var isMock = !!(mb0 && mb0.ui && !mb0.blocks);
  return (async function () {
    for (;;) {
      var perf = (window).__mbPerf;
      var measures = (perf && perf.measures) ? perf.measures : {};
      var booted = Object.keys(measures).some(function (k) {
        return typeof measures[k] === "number";
      });
      var mb = (window).__mb;
      var bridged = !!(mb && mb.ui && mb.blocks);
      if (isMock ? (bridged || booted) : bridged) {
        return { ready: true, isMock: isMock };
      }
      if (Date.now() - start > timeoutMs) {
        return { ready: false, isMock: isMock };
      }
      await new Promise(function (r) { setTimeout(r, 100); });
    }
  })();
})
`;

/**
 * Runs the open-project drop, separating the two kinds of failure.
 *
 * A missing file input is an environment problem: the run still measures
 * whatever the page shows, so it warns and carries on. A guard firing means the
 * workspace is not the one the metrics describe, which is not recoverable --
 * and letting it through is how a phantom load becomes a baseline that looks
 * fine. `fail()` marks the latter.
 */
export async function withOpenProjectGuard(
  body: (fail: () => void) => Promise<void>,
  onEnvironmentError: (message: string) => void,
): Promise<void> {
  let guardFailed = false;
  try {
    await body(() => {
      guardFailed = true;
    });
  } catch (e) {
    if (guardFailed) throw e;
    onEnvironmentError((e as Error).message);
  }
}

export class BenchmarkDriver {
  private config: BenchmarkConfig;

  constructor(config: BenchmarkConfig) {
    this.config = config;
  }

  private startServer(pagesDir: string): Promise<http.Server> {
    const server = http.createServer((req, res) => {
      const filePath = path.join(
        pagesDir,
        req.url === "/" ? "index.html" : (req.url ?? ""),
      );
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(data);
      });
    });
    return new Promise((resolve) => {
      server.listen(this.config.port, () => resolve(server));
    });
  }

  async run(plugins: MetricPlugin[]): Promise<PageResult[]> {
    const { pages, runs, settleMs, port } = this.config;
    const results: PageResult[] = [];

    const pagesDir = process.cwd();
    const hasLocalPages = pages.some((p) => !isUrl(p));
    const server = hasLocalPages ? await this.startServer(pagesDir) : null;
    // Headless Chromium blocks AudioContext autoplay by default, which stalls
    // Tone.js scheduling — and therefore the transport seam (latency / drift)
    // and real playback itself. Lift the gesture requirement so scheduled
    // notes actually fire on benchmarked pages.
    //
    // --expose-gc exposes window.gc() so the memory probes can force a
    // collection before each heap read. --enable-precise-memory-info is the
    // OTHER half and is just as required: without it `performance.memory` is
    // served from a coarse cache that Chromium only refreshes every ~20
    // minutes, so usedJSHeapSize returns the SAME quantised number on every
    // read and every heap delta is exactly 0. Measured on this driver:
    //   --js-flags=--expose-gc only            -> 10.00MB before, 10.00MB
    //                                               after allocating 320MB
    //                                               (delta 0.00MB)
    //   + --enable-precise-memory-info          -> 0.54MB before, 320.63MB
    //                                               after (delta 320.09MB)
    // So --expose-gc alone left memoryDelta / retainedHeap / heapAfterBoot
    // structurally incapable of reporting a non-zero value. Both flags ship.
    const browser: Browser = await chromium.launch({
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--js-flags=--expose-gc",
        "--enable-precise-memory-info",
      ],
    });

    try {
      for (const pageInput of pages) {
        const pageName = isUrl(pageInput)
          ? pageNameFromUrl(pageInput)
          : path.basename(pageInput);
        const url = isUrl(pageInput)
          ? pageInput
          : `http://localhost:${port}/${pageName}`;
        const pageRuns: BenchmarkRun[] = [];

        // The Benchmark Matrix is the source of truth for which metrics may be
        // collected per fixture. Unauthorized combinations are rejected HERE at
        // the data boundary, so they never reach the raw results, the baseline,
        // or the report.
        const approvedPlugins = plugins.filter((p) =>
          isMetricApproved(pageName, p.name),
        );
        const skippedPluginNames = plugins
          .filter((p) => !isMetricApproved(pageName, p.name))
          .map((p) => p.name);
        if (skippedPluginNames.length > 0) {
          console.log(
            `    ${pageName}: skipping metrics not in Benchmark Matrix: ${skippedPluginNames.join(", ")}`,
          );
        }

        // Ordered interaction phases for this page: the config's per-page map
        // wins when present, otherwise the single global scenario.
        const pagePhases: ScenarioName[] = stagePhases(
          this.config.scenarios ? this.config.scenarios[pageName] : undefined,
          this.config.scenario,
        );

        // A page may need more wall clock than the global budget allows; see
        // `runTimeouts` on BenchmarkConfig.
        const runTimeout = resolveRunTimeout(this.config, pageName);
        const override = this.config.runTimeouts?.[pageName];
        if (override !== undefined) {
          console.log(
            `    per-page run timeout ${override}ms (global ${this.config.runTimeoutMs ?? RUN_TIMEOUT_MS}ms)`,
          );
        }

        console.log(
          `\nBenchmarking ${pageName} (${runs} runs)${pagePhases.length > 0 ? `, phases: ${pagePhases.join(" → ")}` : ""} ...`,
        );

        for (let i = 0; i < runs; i++) {
          try {
            await withTimeout(
              (async () => {
                const context = await browser.newContext();
                const page: Page = await context.newPage();
                const runStartT0 = Date.now();
                page.on("pageerror", (e) => {
                  console.warn(
                    `    [pageerror] ${(e as Error).message.slice(0, 200)}`,
                  );
                });
                page.on("console", (m) => {
                  if (m.type() === "error") {
                    console.warn(
                      `    [console.error] ${m.text().slice(0, 200)}`,
                    );
                  }
                });

                for (const plugin of approvedPlugins) {
                  await plugin.setupPage(page);
                }

                await page.goto(url, { waitUntil: "load" });
                console.log(`    goto done at +${Date.now() - runStartT0}ms`);

                for (const plugin of approvedPlugins) {
                  if (plugin.setupPostNav) {
                    await plugin.setupPostNav(page);
                  }
                }
                console.log(
                  `    setupPostNav done at +${Date.now() - runStartT0}ms`,
                );

                const fixtureAbs = this.config.fixtures
                  ? this.config.fixtures[pageName]
                  : undefined;
                for (const phase of pagePhases) {
                  const phaseStart = Date.now();
                  if (phase === Scenario.OpenProject && fixtureAbs) {
                    // The app attaches the file input's 'change' handler during
                    // activity init, which finishes seconds AFTER the page 'load'
                    // event. Dropping the file before the handler exists silently
                    // does nothing, so the project never opens and the phase's
                    // stability wait burns the whole run budget. `window.__mb` is
                    // only created at the END of init, so absence of the bridge
                    // at this point does NOT mean the page is a static mock.
                    // Static mocks set window.__mb synchronously at parse time; the real
                    // Music Blocks app creates the bridge only at the END of
                    // activity init (seconds after "load"), carrying both `ui`
                    // and `blocks` -- which is how the gate tells them apart. The
                    // real app must wait for `bridged` (mb.ui && mb.blocks) so the
                    // fixture drop cannot race the change handler and get silently
                    // swallowed (phantom projectLoadTime).
                    await withOpenProjectGuard(
                      async (fail) => {
                        const gate = (await callWithArg(
                        page,
                        openProjectGateSnippet,
                        120000,
                      )) as { ready: boolean; isMock: boolean };
                      const ready = gate.ready;
                      const isMockPage = gate.isMock;
                      if (ready) {
                        await page.setInputFiles("#myOpenFile", fixtureAbs);
                        console.log(
                          `    file dropped at +${Date.now() - runStartT0}ms`,
                        );
                        // Verify the fixture actually opened. The app's change
                        // listener records perfMarks.openStart the moment the
                        // file input fires, so its presence proves the drop was
                        // not swallowed. Fail the run loudly instead of letting
                        // a phantom load produce a fake constant projectLoadTime.
                        // Mocks have no perfMarks seam, so verify real app
                        // pages only.
                        const opened = isMockPage
                          ? true
                          : await page.evaluate(
                          async (timeoutMs: number) => {
                            const start = Date.now();
                            for (;;) {
                              const mb = (window as any).__mb;
                              if (
                                mb &&
                                mb.perfMarks &&
                                typeof mb.perfMarks.openStart === "number"
                              ) {
                                return true;
                              }
                              if (Date.now() - start > timeoutMs) return false;
                              await new Promise((r) => setTimeout(r, 100));
                            }
                          },
                          30000,
                        );
                        if (!opened) {
                          fail();
                          throw new Error(
                            `fixture ${fixtureAbs} never opened: #myOpenFile change handler did not fire within 30s`,
                          );
                        }
                        // Do not add a block-count wait here. openProjectSnippet
                        // already holds the count steady across 7 samples before
                        // it reports ready, and it is the phase that owns
                        // projectLoadTime -- a second wait would inflate that
                        // number by its own duration.
                      } else {
                        console.warn(
                          "  [openProject] app never became init-complete; skipping file drop",
                        );
                      }
                      },
                      (message) =>
                        console.warn(`  [openProject] no file input (${message})`),
                    );
                  }
                  try {
                    await runScenario(phase, page, {
                      fixtureName: fixtureAbs
                        ? path.basename(fixtureAbs)
                        : undefined,
                      // Honor the running budget; the per-run timeout stays in charge.
                      timeoutMs: runTimeout,
                      panSteps: this.config.panSteps,
                      panSettleMs: this.config.panSettleMs,
                      repeatRuns: this.config.repeatRuns,
                    });
                    console.log(
                      `    ${phase} done in ${Date.now() - phaseStart}ms`,
                    );
                  } catch (e) {
                    console.warn(
                      `  [${phase}] scenario failed (${(e as Error).message})`,
                    );
                  }
                }

                await page.waitForTimeout(settleMs);

                const runMetrics: Record<string, number | null> = {};

                for (const plugin of approvedPlugins) {
                  const metricValue = await plugin.extractMetric(page);
                  runMetrics[plugin.name] = metricValue.value;
                }

                await context.close();
                return runMetrics;
              })(),
              runTimeout,
            ).then((runMetrics) => {
              pageRuns.push({ run: i + 1, metrics: runMetrics });

              const line =
                `  run ${i + 1}/${runs} -> ` +
                approvedPlugins
                  .map((p) => {
                    const v = runMetrics[p.name];
                    const unit =
                      p.meta.unit === "blocks/s" ? "blk/s" : p.meta.unit;
                    return `${p.name}: ${v !== null && v !== undefined ? v.toFixed(1) : "null"}${unit}`;
                  })
                  .join(", ");
              console.log(line);
            });
          } catch (e) {
            console.warn(
              `  run ${i + 1}/${runs} skipped: ${(e as Error).message}`,
            );
          }
        }

        results.push({ page: pageName, runs: pageRuns });
      }
    } finally {
      await browser.close();
      if (server) {
        server.close();
      }
    }

    return results;
  }
}
