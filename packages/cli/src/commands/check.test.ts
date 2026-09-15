import { describe, it, expect } from 'vitest';
import { clampStatus } from './check';

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