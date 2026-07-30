import type { Page, Request, Response } from 'playwright';
import type { Evidence, EvidenceHighlight } from '@perfsense/core';
import * as crypto from 'crypto';

function makeId(): string {
  return 'net-' + crypto.randomBytes(4).toString('hex') + '-' + Date.now().toString(36);
}

interface CapturedRequest {
  url: string;
  method: string;
  status: number;
  size: number;
  duration: number;
  dns: number;
  tcp: number;
  ssl: number;
  ttfb: number;
  type: string;
}

export async function collectNetworkEvidence(
  page: Page,
  metricName: string,
): Promise<Evidence> {
  const startTime = Date.now();
  const requests: CapturedRequest[] = [];
  const reqMap = new Map<string, CapturedRequest>();

  const onRequest = (req: Request) => {
    const entry: CapturedRequest = {
      url: req.url(),
      method: req.method(),
      status: 0,
      size: 0,
      duration: 0,
      dns: 0,
      tcp: 0,
      ssl: 0,
      ttfb: 0,
      type: req.resourceType() || 'unknown',
    };
    reqMap.set(req.url(), entry);
  };

  const onResponse = (res: Response) => {
    const req = res.request();
    const entry = reqMap.get(req.url());
    if (!entry) return;
    entry.status = res.status();
    const headers = res.headers();
    entry.size = parseInt(headers['content-length'] || '0', 10) || 0;

    const timing = req.timing();
    if (timing) {
      entry.dns = Math.max(0, (timing.domainLookupEnd ?? -1) - (timing.domainLookupStart ?? -1));
      entry.tcp = Math.max(0, (timing.connectEnd ?? -1) - (timing.connectStart ?? -1));
      entry.ssl = Math.max(0, (timing.connectEnd ?? -1) - (timing.secureConnectionStart ?? -1));
      entry.ttfb = Math.max(0, (timing.responseStart ?? -1) - (timing.requestStart ?? -1));
      entry.duration = Math.max(0, (timing.responseEnd ?? -1) - (timing.requestStart ?? -1));
    }
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      finalize();
    }, 5000);

    function finalize() {
      clearTimeout(timer);
      page.removeListener('request', onRequest);
      page.removeListener('response', onResponse);

      for (const entry of reqMap.values()) {
        requests.push(entry);
      }

      const failed = requests.filter((r) => r.status >= 400);
      requests.sort((a, b) => b.duration - a.duration);
      const slowest = requests.length > 0 ? requests[0] : null;

      const highlights: EvidenceHighlight[] = [];

      if (failed.length > 0) {
        highlights.push({
          label: 'Failed requests',
          value: `${failed.length} request(s) failed: ${failed.map((r) => r.url).join(', ')}`,
          severity: 'critical',
        });
      }

      if (slowest && slowest.duration > 0) {
        highlights.push({
          label: 'Slowest request',
          value: `${slowest.url} — ${slowest.duration.toFixed(1)}ms (DNS: ${slowest.dns.toFixed(1)}ms, TCP: ${slowest.tcp.toFixed(1)}ms, SSL: ${slowest.ssl.toFixed(1)}ms, TTFB: ${slowest.ttfb.toFixed(1)}ms)`,
          severity: slowest.duration > 1000 ? 'critical' : slowest.duration > 300 ? 'warning' : 'info',
        });
      }

      if (requests.length > 0) {
        const totalSize = requests.reduce((s, r) => s + r.size, 0);
        highlights.push({
          label: 'Total network',
          value: `${requests.length} requests, ${(totalSize / 1024).toFixed(1)}KB transferred`,
          severity: 'info',
        });
      }

      let summary = 'Network waterfall collected';
      if (slowest && slowest.duration > 0) {
        summary = `Slowest: ${slowest.url} (${slowest.duration.toFixed(1)}ms)`;
      }
      if (failed.length > 0) {
        summary += `, ${failed.length} failed`;
      }

      resolve({
        id: makeId(),
        type: 'network',
        metricName,
        timestamp: startTime,
        confidence: requests.length > 0 ? 0.9 : 0.2,
        summary,
        highlights: highlights.length > 0
          ? highlights
          : [{ label: 'Network', value: 'No network activity captured', severity: 'info' as const }],
        details: { requests: requests.length > 20 ? requests.slice(0, 20) : requests },
      });
    }
  });
}
