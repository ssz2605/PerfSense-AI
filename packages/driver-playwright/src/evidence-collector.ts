import { chromium } from 'playwright';
import type { Browser, Page, BrowserContext, Response } from 'playwright';
import type { MetricPlugin, Evidence, EvidenceHighlight } from '@perfsense/core';
import { collectGitDiffEvidence } from '@perfsense/evidence-git-diff';
import * as crypto from 'crypto';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { setTimeout as sleep } from 'timers/promises';

const GIT_DIFF_TIMEOUT = 5000;

function makeId(prefix: string): string {
  return prefix + '-' + crypto.randomBytes(4).toString('hex') + '-' + Date.now().toString(36);
}

function captureTiming(entry: { status: number; size: number; dns: number; tcp: number; ssl: number; ttfb: number; duration: number; url?: string; method?: string; type?: string }, res: Response): void {
  entry.status = res.status();
  entry.size = parseInt(res.headers()['content-length'] || '0', 10) || 0;
  const timing = res.request().timing();
  if (timing) {
    entry.dns = Math.max(0, (timing.domainLookupEnd ?? -1) - (timing.domainLookupStart ?? -1));
    entry.tcp = Math.max(0, (timing.connectEnd ?? -1) - (timing.connectStart ?? -1));
    entry.ssl = Math.max(0, (timing.connectEnd ?? -1) - (timing.secureConnectionStart ?? -1));
    entry.ttfb = Math.max(0, (timing.responseStart ?? -1) - (timing.requestStart ?? -1));
    entry.duration = Math.max(0, (timing.responseEnd ?? -1) - (timing.requestStart ?? -1));
  }
}

export class EvidenceCollector {
  private port: number;
  private settleMs: number;

  constructor(port = 8935, settleMs = 1500) {
    this.port = port;
    this.settleMs = settleMs;
  }

  async collect(
    plugins: MetricPlugin[],
    pagesDir: string,
    pagePaths: string[],
  ): Promise<Record<string, Evidence[]>> {
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

    await new Promise<void>((resolve) => {
      server.listen(this.port, () => resolve());
    });

    const browser: Browser = await chromium.launch({ headless: true });

    try {
      const result: Record<string, Evidence[]> = {};

      for (const pagePath of pagePaths) {
        const pageName = path.basename(pagePath);
        console.error(`  [evidence] Re-running ${pageName} with tracing ...`);

        const context: BrowserContext = await browser.newContext();
        const page: Page = await context.newPage();

        // Network tracking
        const reqMap = new Map<string, {
          url: string; method: string; status: number; size: number;
          dns: number; tcp: number; ssl: number; ttfb: number; duration: number; type: string;
        }>();

        page.on('response', (res: Response) => {
          const url = res.request().url();
          let entry = reqMap.get(url);
          if (!entry) {
            entry = { url, method: res.request().method(), status: 0, size: 0, dns: 0, tcp: 0, ssl: 0, ttfb: 0, duration: 0, type: res.request().resourceType() || 'document' };
            reqMap.set(url, entry);
          }
          captureTiming(entry, res);
        });
        page.on('requestfailed', (req) => {
          const url = req.url();
          let entry = reqMap.get(url);
          if (!entry) {
            entry = { url, method: req.method(), status: 599, size: 0, dns: 0, tcp: 0, ssl: 0, ttfb: 0, duration: 0, type: req.resourceType() || 'unknown' };
            reqMap.set(url, entry);
          }
          entry.status = 599;
        });

        // Start tracing before navigation
        await context.tracing.start({ screenshots: false, snapshots: false });

        // Record navigation start time
        const navStart = Date.now();

        for (const plugin of plugins) {
          await plugin.setupPage(page);
        }

        await page.goto(`http://localhost:${this.port}/${pageName}`, { waitUntil: 'load' });

        for (const plugin of plugins) {
          if (plugin.setupPostNav) {
            await plugin.setupPostNav(page);
          }
        }

        await page.waitForTimeout(this.settleMs);

        const totalLoadMs = Date.now() - navStart;
        const firstMetric = plugins.length > 0 ? plugins[0].name : 'unknown';

        // Extract page-timing data
        let timingData: { domContentLoaded?: number; domNodes: number; scriptDuration?: number; } = { domNodes: 0 };
        try {
          timingData = await page.evaluate(() => {
            const nav = performance.getEntriesByType('navigation')[0] as any;
            return {
              domContentLoaded: nav?.domContentLoadedEventEnd || undefined,
              domNodes: document.querySelectorAll('*').length,
              scriptDuration: nav?.domInteractive || undefined,
            };
          });
        } catch { /* ignore */ }

        // Stop tracing
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perfsense-trace-'));
        const tracePath = path.join(tmpDir, 'trace.zip');
        await context.tracing.stop({ path: tracePath });
        const traceFileSize = fs.existsSync(tracePath) ? fs.statSync(tracePath).size : 0;

        // Build trace evidence
        const traceHighlights: EvidenceHighlight[] = [];
        if (totalLoadMs > 0) {
          const sev = totalLoadMs > 2000 ? 'critical' : totalLoadMs > 500 ? 'warning' : 'info';
          traceHighlights.push({ label: 'Total page time', value: `${totalLoadMs.toFixed(0)}ms`, severity: sev });
        }
        if (timingData.domContentLoaded) {
          traceHighlights.push({ label: 'DOMContentLoaded', value: `${timingData.domContentLoaded.toFixed(0)}ms`, severity: 'info' });
        }
        if (timingData.domNodes > 0) {
          traceHighlights.push({ label: 'DOM complexity', value: `${timingData.domNodes} nodes`, severity: timingData.domNodes > 200 ? 'warning' : 'info' });
        }
        if (timingData.scriptDuration && timingData.scriptDuration > 0) {
          const sev = timingData.scriptDuration > 300 ? 'critical' : timingData.scriptDuration > 100 ? 'warning' : 'info';
          traceHighlights.push({ label: 'Script execution', value: `${timingData.scriptDuration.toFixed(0)}ms`, severity: sev });
        }
        if (traceFileSize > 0) {
          traceHighlights.push({ label: 'Trace file', value: `${(traceFileSize / 1024).toFixed(1)}KB`, severity: 'info' });
        }

        const traceSummary = totalLoadMs > 0 ? `Page loaded in ${totalLoadMs}ms` : 'Chrome trace collected';
        const traceEv: Evidence = {
          id: makeId('trace'),
          type: 'trace',
          metricName: firstMetric,
          timestamp: Date.now(),
          confidence: traceHighlights.length > 0 ? 0.8 : 0.3,
          summary: traceSummary,
          highlights: traceHighlights.length > 0 ? traceHighlights : [{ label: 'Trace', value: 'No significant findings', severity: 'info' as const }],
          details: { traceFile: tracePath, fileSizeBytes: traceFileSize, totalLoadMs },
        };

        // Build network evidence
        const netReqs = Array.from(reqMap.values());
        const failed: typeof netReqs = [];
        for (const r of netReqs) {
          if (r.status >= 400 && !/favicon/i.test(r.url)) failed.push(r);
        }
        netReqs.sort((a, b) => b.duration - a.duration);
        const slowest = netReqs.find((r) => r.duration > 0) || null;
        const netHighlights: EvidenceHighlight[] = [];
        if (failed.length > 0) {
          netHighlights.push({ label: 'Failed requests', value: `${failed.length} request(s): ` + failed.map((r) => ` ${r.url} (${r.status})`).join(', '), severity: 'critical' });
        }
        if (slowest && slowest.duration > 0) {
          netHighlights.push({
            label: 'Slowest request',
            value: `${new URL(slowest.url).pathname} (${slowest.duration.toFixed(1)}ms, DNS:${slowest.dns.toFixed(0)}ms TCP:${slowest.tcp.toFixed(0)}ms TTFB:${slowest.ttfb.toFixed(0)}ms)`,
            severity: slowest.duration > 1000 ? 'critical' : slowest.duration > 300 ? 'warning' : 'info',
          });
        }
        if (netReqs.length > 0) {
          const totalSize = netReqs.reduce((s, r) => s + r.size, 0);
          netHighlights.push({ label: 'Total network', value: `${netReqs.length} requests, ${(totalSize / 1024).toFixed(1)}KB`, severity: 'info' });
        }

        const navReq = netReqs.find((r) => r.url.includes(pageName));
        const netSummary = navReq && navReq.duration > 0
          ? `Page load: ${navReq.duration.toFixed(0)}ms`
          : `${netReqs.length} requests`;
        const netEv: Evidence = {
          id: makeId('net'),
          type: 'network',
          metricName: firstMetric,
          timestamp: Date.now(),
          confidence: netReqs.length > 0 ? 0.9 : 0.2,
          summary: netSummary,
          highlights: netHighlights.length > 0 ? netHighlights : [{ label: 'Network', value: `${netReqs.length} requests`, severity: 'info' as const }],
          details: { requests: netReqs.length > 20 ? netReqs.slice(0, 20) : netReqs },
        };

        await context.close();

        // Git diff
        const gitDiffEv: Evidence = await (async () => {
          const result = await Promise.race([
            Promise.resolve().then(() => collectGitDiffEvidence(firstMetric)),
            sleep(GIT_DIFF_TIMEOUT).then(() => 'timeout' as const),
          ]);
          if (result === 'timeout') {
            return {
              id: makeId('git'),
              type: 'git-diff' as const,
              metricName: firstMetric,
              timestamp: Date.now(),
              confidence: 0,
              summary: 'Git diff timed out',
              highlights: [{ label: 'Git diff', value: 'Timed out after 5s', severity: 'info' as const }],
            };
          }
          return result;
        })();

        result[pageName] = [traceEv, netEv, gitDiffEv];
      }

      return result;
    } finally {
      await browser.close();
      server.close();
    }
  }
}
