import { describe, it, expect } from 'vitest';
import { clampStatus, findDeadSeamPages } from './check';
import type { BaselineData, PageResult } from '@perfsense/core';

describe('clampStatus (maxStatus ceiling)', () => {
  it('caps REGRESSION at WARNING for warn-only metrics', () => {
    expect(clampStatus('REGRESSION', 'warning')).toBe('WARNING');
    expect(clampStatus('WARNING', 'warning')).toBe('WARNING');
    expect(clampStatus('PASS', 'warning')).toBe('PASS');
  });

  it('caps everything at PASS when the config forbids flags', () => {
    expect(clampStatus('REGRESSION', 'pass')).toBe('PASS');
    expect(clampStatus('WARNING', 'pass')).toBe('PASS');
    expect(clampStatus('PASS', 'pass')).toBe('PASS');
  });

  it('passes the status through unchanged when no cap is configured', () => {
    expect(clampStatus('REGRESSION', undefined)).toBe('REGRESSION');
    expect(clampStatus('WARNING', undefined)).toBe('WARNING');
    expect(clampStatus('PASS', undefined)).toBe('PASS');
  });
});

function pageResult(page: string, metrics: Record<string, number | null>): PageResult {
  return { page, runs: [{ run: 1, metrics }] };
}

/** Minimal baseline carrying a single median cell, which is all the seam reads. */
function baselineWithRatio(page: string, median: number): BaselineData {
  return {
    schema: 'perfsense-baseline-v2',
    schemaVersion: 2,
    createdAt: '2026-09-20T00:00:00.000Z',
    generatedAt: '2026-09-20T00:00:00.000Z',
    runs: 5,
    pages: {
      [page]: {
        transportEventRatio: { median } as BaselineData['pages'][string]['transportEventRatio'],
      },
    },
    source: 'test',
    commitSHA: 'abc123',
    harness: { ref: 'deadbee', source: 'PERFSENSE_REF' },
    env: {
      os: 'linux 6.8.0',
      arch: 'x64',
      node: 'v20.11.0',
      cpu: 'Xeon',
      cores: 4,
      memoryGB: 16,
      coldState: true,
    },
  };
}

describe('findDeadSeamPages (Layer A tripwire)', () => {
  const isAudioApproved = (page: string): boolean =>
    page === 'Frere-Jacques.html';

  // The signal is transportEventRatio, not the retired scheduleCount: it counts
  // both sides of the seam, so it stays meaningful at low absolute ratios and
  // drops to 0 exactly when scheduling reverts to setTimeout.
  it('flags a page whose seam fired nothing and kept no audio observations', () => {
    const current = [
      pageResult('Frere-Jacques.html', {
        transportEventRatio: 0,
        callbackLatencyMean: null,
        callbackLatencyMax: null,
        cumulativeDrift: null,
        voiceOnsetError: null,
      }),
    ];
    const findings = findDeadSeamPages(current, isAudioApproved);
    expect(findings).toHaveLength(1);
    expect(findings[0].page).toBe('Frere-Jacques.html');
    expect(findings[0].check.alive).toBe(false);
  });

  it('flags a page with no transport data and no audio values at all', () => {
    const current = [
      pageResult('Frere-Jacques.html', { transportEventRatio: null }),
    ];
    const findings = findDeadSeamPages(current, isAudioApproved);
    expect(findings).toHaveLength(1);
    expect(findings[0].check.transportEventRatio).toBeNull();
  });

  it('flags a live-looking ratio that has collapsed onto the setTimeout fallback', () => {
    // Audio values are present, so the old audio-observation escape hatch would
    // have passed this. A ratio below the floor must still fail.
    const current = [
      pageResult('Frere-Jacques.html', {
        transportEventRatio: 1e-9,
        callbackLatencyMean: 12.4,
        cumulativeDrift: 0.5,
      }),
    ];
    const findings = findDeadSeamPages(current, isAudioApproved);
    expect(findings).toHaveLength(1);
    expect(findings[0].check.alive).toBe(false);
  });

  it('does not flag a live seam (the observed Frere-Jacques ratio)', () => {
    // 268 transport.schedule calls vs 10330 setTimeout delays: low, but the
    // transport path is demonstrably in use.
    const current = [
      pageResult('Frere-Jacques.html', {
        transportEventRatio: 0.0253,
        callbackLatencyMean: 12.4,
        callbackLatencyMax: 40.1,
        cumulativeDrift: 0.5,
        voiceOnsetError: 11.9,
      }),
    ];
    expect(findDeadSeamPages(current, isAudioApproved)).toHaveLength(0);
  });

  it('does not flag when audio observations exist but no ratio was collected', () => {
    const current = [
      pageResult('Frere-Jacques.html', {
        callbackLatencyMean: 12.4,
        cumulativeDrift: 0.5,
      } as PageResult['runs'][number]['metrics']),
    ];
    expect(findDeadSeamPages(current, isAudioApproved)).toHaveLength(0);
  });

  it('holds the seam to half the baseline share, not an absolute 1.0', () => {
    // The observed Frere-Jacques share is ~0.025 because Tone.Transport is never
    // started, so an absolute 1.0 requirement would fire on a correct run. A
    // quarter of the baseline share is four times the old 0.001 absolute floor
    // and still a real collapse, so only a baseline-relative floor catches it.
    const baseline = baselineWithRatio('Frere-Jacques.html', 0.025);
    const quarter = pageResult('Frere-Jacques.html', {
      transportEventRatio: 0.006,
      callbackLatencyMean: 12.4,
      cumulativeDrift: 0.5,
    });
    // Without the baseline the absolute floor lets this through.
    expect(findDeadSeamPages([quarter], isAudioApproved)).toHaveLength(0);
    const findings = findDeadSeamPages([quarter], isAudioApproved, baseline);
    expect(findings).toHaveLength(1);
    expect(findings[0].check.alive).toBe(false);
    expect(findings[0].check.reason).toContain('0.5 of the baseline share');
  });

  it('passes a healthy ratio against the baseline it was measured from', () => {
    const baseline = baselineWithRatio('Frere-Jacques.html', 0.025);
    const current = [
      pageResult('Frere-Jacques.html', {
        transportEventRatio: 0.024,
        callbackLatencyMean: 12.4,
      }),
    ];
    expect(findDeadSeamPages(current, isAudioApproved, baseline)).toHaveLength(0);
  });

  it('does not read a baseline cell from a different page', () => {
    // A baseline recorded against another fixture must not become this page's
    // floor; the check falls back to the absolute floor instead.
    const baseline = baselineWithRatio('musical-tree.html', 0.9);
    const current = [
      pageResult('Frere-Jacques.html', { transportEventRatio: 0.004 }),
    ];
    expect(findDeadSeamPages(current, isAudioApproved, baseline)).toHaveLength(0);
  });

  it('ignores pages whose fixture approves no audio metric', () => {
    const current = [
      pageResult('musical-tree.html', { transportEventRatio: 0 }),
      pageResult('index.html', { bootstrapTotal: 10 }),
    ];
    expect(findDeadSeamPages(current, isAudioApproved)).toHaveLength(0);
  });
});