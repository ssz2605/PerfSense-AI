import type { Page, BrowserContext, CDPSession } from 'playwright';
import type { Evidence, EvidenceHighlight } from '@perfsense/core';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

function makeId(): string {
  return 'trace-' + crypto.randomBytes(4).toString('hex') + '-' + Date.now().toString(36);
}

async function extractLongTasks(page: Page): Promise<EvidenceHighlight[]> {
  try {
    const longTasks = await page.evaluate(() => {
      if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        return [];
      }
      const entries = performance.getEntriesByType('longtask') as unknown as {
        duration: number;
        startTime: number;
        name: string;
        attribution?: { name: string; source?: string; duration: number }[];
      }[];
      return entries.map((e) => ({
        duration: e.duration,
        startTime: e.startTime,
        name: e.name,
        source: e.attribution?.[0]?.source ?? 'unknown',
      }));
    });

    if (longTasks.length === 0) {
      return [{ label: 'Long tasks', value: 'None detected', severity: 'info' as const }];
    }

    longTasks.sort((a, b) => b.duration - a.duration);
    const highlights: EvidenceHighlight[] = [];
    for (const lt of longTasks.slice(0, 3)) {
      highlights.push({
        label: `Long task`,
        value: `${lt.duration.toFixed(1)}ms at ${lt.startTime.toFixed(1)}ms, source: ${lt.source}`,
        severity: lt.duration > 200 ? 'critical' as const : lt.duration > 100 ? 'warning' as const : 'info' as const,
      });
    }
    return highlights;
  } catch {
    return [{ label: 'Long tasks', value: 'Unable to extract', severity: 'info' as const }];
  }
}

async function extractCDPMetrics(page: Page, cdpSession: CDPSession): Promise<EvidenceHighlight[]> {
  try {
    const { metrics } = await cdpSession.send('Performance.getMetrics');
    const map: Record<string, number> = {};
    for (const m of metrics as Array<{ name: string; value: number }>) {
      map[m.name] = m.value;
    }

    const highlights: EvidenceHighlight[] = [];
    const scriptDur = map.ScriptDuration || 0;
    const taskDur = map.TaskDuration || 0;
    const layoutDur = map.LayoutDuration || 0;
    const recalcStyleDur = map.RecalcStyleDuration || 0;

    if (taskDur > 0) {
      highlights.push({
        label: 'Total script execution',
        value: `${scriptDur.toFixed(1)}ms (${(scriptDur / Math.max(taskDur, 1) * 100).toFixed(0)}% of tasks)`,
        severity: scriptDur > 300 ? 'critical' as const : scriptDur > 100 ? 'warning' as const : 'info' as const,
      });
    }
    if (layoutDur > 0) {
      highlights.push({
        label: 'Layout time',
        value: `${layoutDur.toFixed(1)}ms`,
        severity: layoutDur > 50 ? 'warning' as const : 'info' as const,
      });
    }
    if (recalcStyleDur > 0) {
      highlights.push({
        label: 'Style recalculation',
        value: `${recalcStyleDur.toFixed(1)}ms`,
        severity: recalcStyleDur > 50 ? 'warning' as const : 'info' as const,
      });
    }
    return highlights;
  } catch {
    return [];
  }
}

async function extractUserTimings(page: Page): Promise<EvidenceHighlight[]> {
  try {
    const measures = await page.evaluate(() => {
      return performance.getEntriesByType('measure').map((m) => ({
        name: m.name,
        duration: m.duration,
      }));
    });
    if (measures.length === 0) return [];
    measures.sort((a: { duration: number }, b: { duration: number }) => b.duration - a.duration);
    return [{
      label: 'User timings',
      value: `Longest: ${measures[0].name} (${measures[0].duration.toFixed(1)}ms)`,
      severity: measures[0].duration > 50 ? 'warning' as const : 'info' as const,
    }];
  } catch {
    return [];
  }
}

export async function collectTraceEvidence(
  page: Page,
  context: BrowserContext,
  metricName: string,
): Promise<Evidence> {
  const startTime = Date.now();

  let cdpSession: CDPSession | null = null;
  try {
    cdpSession = await (context as any).newCDPSession(page);
    await cdpSession!.send('Performance.enable');
  } catch {
    // CDP not available (non-Chromium or API not exposed)
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perfsense-trace-'));
  const tracePath = path.join(tmpDir, 'trace.zip');

  await context.tracing.start({ screenshots: false, snapshots: false });

  const longTaskHLs = await extractLongTasks(page);
  const cdpHLs = cdpSession ? await extractCDPMetrics(page, cdpSession!) : [];
  const timingHLs = await extractUserTimings(page);

  await context.tracing.stop({ path: tracePath });

  const allHLs: EvidenceHighlight[] = [...longTaskHLs, ...cdpHLs, ...timingHLs];
  const traceFileSize = fs.existsSync(tracePath) ? fs.statSync(tracePath).size : 0;

  let summary = 'Chrome trace collected';
  if (allHLs.length > 0) {
    const criticalItems = allHLs.filter((h) => h.severity === 'critical');
    if (criticalItems.length > 0) {
      summary = `Main thread blocked: ` + criticalItems.map((h) => h.value).join('; ');
    } else {
      summary = allHLs[0].value;
    }
  }

  const details: Record<string, unknown> = {};
  try {
    if (fs.existsSync(tracePath)) {
      details.traceFile = tracePath;
      details.fileSizeBytes = traceFileSize;
    }
  } catch {
    // ignore
  }

  return {
    id: makeId(),
    type: 'trace',
    metricName,
    timestamp: startTime,
    confidence: longTaskHLs.length > 0 || cdpHLs.length > 0 ? 0.8 : 0.3,
    summary,
    highlights: allHLs.length > 0 ? allHLs : [{ label: 'Trace', value: 'No significant findings', severity: 'info' as const }],
    details,
  };
}
