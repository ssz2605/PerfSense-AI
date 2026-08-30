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
import { runScenario, isScenario, Scenario } from "./scenarios";
import type { ScenarioName } from "./scenarios";

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
    const runTimeout = this.config.runTimeoutMs ?? RUN_TIMEOUT_MS;
    const results: PageResult[] = [];

    const pagesDir = process.cwd();
    const hasLocalPages = pages.some((p) => !isUrl(p));
    const server = hasLocalPages ? await this.startServer(pagesDir) : null;
    const browser: Browser = await chromium.launch();

    try {
      for (const pageInput of pages) {
        const pageName = isUrl(pageInput)
          ? pageNameFromUrl(pageInput)
          : path.basename(pageInput);
        const url = isUrl(pageInput)
          ? pageInput
          : `http://localhost:${port}/${pageName}`;
        const pageRuns: BenchmarkRun[] = [];

        // Ordered interaction phases for this page: the config's per-page map
        // wins when present, otherwise the single global scenario.
        const pagePhases: ScenarioName[] = stagePhases(
          this.config.scenarios ? this.config.scenarios[pageName] : undefined,
          this.config.scenario,
        );

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

                for (const plugin of plugins) {
                  await plugin.setupPage(page);
                }

                await page.goto(url, { waitUntil: "load" });
                console.log(`    goto done at +${Date.now() - runStartT0}ms`);

                for (const plugin of plugins) {
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
                    // stability wait burns the whole run budget. Wait for the
                    // init-complete signal (`window.__mb` bridge with `ui` and
                    // `blocks`) before injecting the fixture. Pages without the
                    // bridge (static mocks) proceed immediately.
                    try {
                      // The app attaches the file input's 'change' handler during
                      // activity init, which finishes seconds AFTER the page 'load'
                      // event. Dropping the file before the handler exists silently
                      // does nothing, so the project never opens and the phase's
                      // stability wait burns the whole run budget. `window.__mb` is
                      // only created at the END of init, so absence of the bridge
                      // at this point does NOT mean the page is a static mock.
                      // Wait for init-complete = bridge present OR real boot
                      // measures landed (mocks set __mbPerf.measures inline, so
                      // they pass immediately and are never delayed).
                      const ready = await page.evaluate(
                        async (timeoutMs: number) => {
                          const start = Date.now();
                          for (;;) {
                            const perf = (window as any).__mbPerf;
                            const measures =
                              perf && perf.measures ? perf.measures : {};
                            const booted = Object.keys(measures).some(
                              (k) => typeof measures[k] === "number",
                            );
                            const mb = (window as any).__mb;
                            const bridged = !!(mb && mb.ui && mb.blocks);
                            if (bridged || booted) return true;
                            if (Date.now() - start > timeoutMs) return false;
                            await new Promise((r) => setTimeout(r, 100));
                          }
                        },
                        120000,
                      );
                      if (ready) {
                        await page.setInputFiles("#myOpenFile", fixtureAbs);
                        console.log(
                          `    file dropped at +${Date.now() - runStartT0}ms`,
                        );
                      } else {
                        console.warn(
                          "  [openProject] app never became init-complete; skipping file drop",
                        );
                      }
                    } catch (e) {
                      console.warn(
                        `  [openProject] no file input (${(e as Error).message})`,
                      );
                    }
                  }
                  try {
                    await runScenario(phase, page, {
                      fixtureName: fixtureAbs
                        ? path.basename(fixtureAbs)
                        : undefined,
                      // Honor the running budget; the per-run timeout stays in charge.
                      timeoutMs: runTimeout,
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

                for (const plugin of plugins) {
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
                plugins
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
