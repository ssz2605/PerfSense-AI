import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import type { MetricPlugin, BenchmarkConfig, BenchmarkRun, PageResult } from '@perfsense/core';
import { runScenario, isScenario } from './scenarios';

export function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function pageNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const proj = u.searchParams.get('perfsenseProject');
    if (proj) {
      const seg = proj.split('/').filter(Boolean).pop();
      if (seg) return seg;
    }
    return u.pathname.split('/').filter(Boolean).pop() || 'index';
  } catch {
    return url;
  }
}

const RUN_TIMEOUT_MS = 120000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`run exceeded ${ms}ms timeout, skipping`)), ms);
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
      const filePath = path.join(pagesDir, req.url === '/' ? 'index.html' : req.url ?? '');
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
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
    const browser: Browser = await chromium.launch();

    try {
      for (const pageInput of pages) {
        const pageName = isUrl(pageInput) ? pageNameFromUrl(pageInput) : path.basename(pageInput);
        const url = isUrl(pageInput) ? pageInput : `http://localhost:${port}/${pageName}`;
        const pageRuns: BenchmarkRun[] = [];

        console.log(`\nBenchmarking ${pageName} (${runs} runs) ...`);

        for (let i = 0; i < runs; i++) {
          try {
            await withTimeout(
              (async () => {
                const context = await browser.newContext();
                const page: Page = await context.newPage();

                for (const plugin of plugins) {
                  await plugin.setupPage(page);
                }

                await page.goto(url, { waitUntil: 'load' });

                for (const plugin of plugins) {
                  if (plugin.setupPostNav) {
                    await plugin.setupPostNav(page);
                  }
                }

                if (this.config.scenario && isScenario(this.config.scenario)) {
                  const fixtureAbs = this.config.fixtures ? this.config.fixtures[pageName] : undefined;
                  if (this.config.scenario === 'openProject' && fixtureAbs) {
                    try {
                      await page.setInputFiles('#myOpenFile', fixtureAbs);
                    } catch (e) {
                      console.warn(`  [${this.config.scenario}] no file input (${(e as Error).message})`);
                    }
                  }
                  try {
                    await runScenario(this.config.scenario, page, {
                      fixtureName: fixtureAbs ? path.basename(fixtureAbs) : undefined,
                      // Honor the running budget; the per-run timeout stays in charge.
                      timeoutMs: RUN_TIMEOUT_MS
                    });
                  } catch (e) {
                    console.warn(`  [${this.config.scenario}] scenario failed (${(e as Error).message})`);
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
              RUN_TIMEOUT_MS
            ).then((runMetrics) => {
              pageRuns.push({ run: i + 1, metrics: runMetrics });

              const line = `  run ${i + 1}/${runs} -> ` +
                plugins.map((p) => {
                  const v = runMetrics[p.name];
                  const unit = p.meta.unit === 'blocks/s' ? 'blk/s' : p.meta.unit;
                  return `${p.name}: ${v !== null ? v.toFixed(1) : 'null'}${unit}`;
                }).join(', ');
              console.log(line);
            });
          } catch (e) {
            console.warn(`  run ${i + 1}/${runs} skipped: ${(e as Error).message}`);
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
