import { describe, it, expect } from 'vitest';
import { clampStatus, findDeadSeamPages } from './check';
import type { PageResult } from '@perfsense/core';

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

  it('ignores pages whose fixture approves no audio metric', () => {
    const current = [
      pageResult('musical-tree.html', { transportEventRatio: 0 }),
      pageResult('index.html', { bootstrapTotal: 10 }),
    ];
    expect(findDeadSeamPages(current, isAudioApproved)).toHaveLength(0);
  });
});