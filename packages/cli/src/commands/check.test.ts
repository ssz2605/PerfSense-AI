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

  it('flags a page whose seam fired nothing and kept no audio observations', () => {
    const current = [
      pageResult('Frere-Jacques.html', {
        scheduleCount: 0,
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

  it('flags a page with no schedule events and no audio values at all', () => {
    const current = [
      pageResult('Frere-Jacques.html', { scheduleCount: null }),
    ];
    const findings = findDeadSeamPages(current, isAudioApproved);
    expect(findings).toHaveLength(1);
  });

  it('does not flag a live seam (schedule events fired)', () => {
    const current = [
      pageResult('Frere-Jacques.html', {
        scheduleCount: 268,
        callbackLatencyMean: 12.4,
        callbackLatencyMax: 40.1,
        cumulativeDrift: 0.5,
        voiceOnsetError: 11.9,
      }),
    ];
    expect(findDeadSeamPages(current, isAudioApproved)).toHaveLength(0);
  });

  it('does not flag when audio observations exist even without a count', () => {
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
      pageResult('musical-tree.html', { scheduleCount: 0 }),
      pageResult('index.html', { bootstrapTotal: 10 }),
    ];
    expect(findDeadSeamPages(current, isAudioApproved)).toHaveLength(0);
  });
});