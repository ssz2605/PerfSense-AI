import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import type { BaselineData, CpuThrottle, EnvironmentFingerprint } from '@perfsense/core';
import {
  parseCpuQuota,
  detectCpuThrottle,
  environmentsMatch,
  environmentComparison,
  throttleStatesMatch,
  resolveBaselineHarness,
  currentHarnessRef,
  harnessComparability,
} from './env';

const BASE: EnvironmentFingerprint = {
  os: 'linux 5.15.0',
  arch: 'x64',
  node: 'v20.11.1',
  cpu: 'Intel Xeon Platinum 8375C',
  cores: 4,
  memoryGB: 16,
  coldState: true,
};

describe('parseCpuQuota', () => {
  it('reads a cgroup v2 quota', () => {
    expect(parseCpuQuota('200000 100000')).toBe(2);
  });

  it('reads a fractional cgroup v2 quota', () => {
    expect(parseCpuQuota('150000 100000')).toBe(1.5);
  });

  it('reports an unlimited cgroup v2 quota as unknown rather than unthrottled', () => {
    expect(parseCpuQuota('max 100000')).toBeNull();
  });

  it('reports an absent cgroup v2 quota as unknown', () => {
    expect(parseCpuQuota(undefined)).toBeNull();
  });

  it('ignores a malformed cgroup v2 line', () => {
    expect(parseCpuQuota('not-a-number 100000')).toBeNull();
  });

  it('reads a cgroup v1 quota/period pair', () => {
    expect(parseCpuQuota(undefined, '200000', '100000')).toBe(2);
  });

  it('treats the cgroup v1 -1 quota as unlimited', () => {
    expect(parseCpuQuota(undefined, '-1', '100000')).toBeNull();
  });

  it('needs both cgroup v1 values', () => {
    expect(parseCpuQuota(undefined, '200000', undefined)).toBeNull();
  });

  it('rejects a zero period', () => {
    expect(parseCpuQuota('200000 0')).toBeNull();
  });
});

describe('detectCpuThrottle', () => {
  it('reads this host, reporting unknown where cgroups are unavailable', () => {
    const result = detectCpuThrottle(4);
    expect(['cgroup-v2', 'cgroup-v1', 'unavailable']).toContain(result.source);
    expect(typeof result.throttled === 'boolean' || result.throttled === null).toBe(true);
  });

  it('never claims a host with no cgroup accounting is throttled', () => {
    // Windows and unprivileged containers have no readable quota; the answer
    // has to be "unknown" so a real throttle is not silently ruled out.
    const result = detectCpuThrottle(2);
    if (result.source === 'unavailable') expect(result.throttled).toBeNull();
  });

  // The v2 and v1 paths must answer the same question the same way. These
  // inject the cgroup files rather than mocking fs so the branch that actually
  // runs is the one under test.
  describe('cgroup v1 parity with v2', () => {
    const withCgroup = (files: Record<string, string>, cores: number): CpuThrottle => {
      const real = fs.readFileSync;
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
        p: string,
        ...rest: unknown[]
      ): unknown => {
        const key = String(p);
        return key in files ? files[key] : (real as (...a: unknown[]) => unknown)(p, ...rest);
      }) as unknown as typeof fs.readFileSync);
      try {
        return detectCpuThrottle(cores);
      } finally {
        spy.mockRestore();
      }
    };

    const V1 = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
    const V1P = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';

    it('reports a v1 quota below the core count as throttled', () => {
      // 4 visible cores, 2 cores of quota: every metric inflates together.
      const result = withCgroup({ [V1]: '200000\n', [V1P]: '100000\n' }, 4);
      expect(result.source).toBe('cgroup-v1');
      expect(result.quotaCpus).toBe(2);
      expect(result.throttled).toBe(true);
    });

    it('reports a v1 quota at or above the core count as unthrottled', () => {
      const result = withCgroup({ [V1]: '400000\n', [V1P]: '100000\n' }, 4);
      expect(result.source).toBe('cgroup-v1');
      expect(result.quotaCpus).toBe(4);
      expect(result.throttled).toBe(false);
    });

    it('reports a v1 unlimited quota as unknown, not unthrottled', () => {
      const result = withCgroup({ [V1]: '-1\n', [V1P]: '100000\n' }, 4);
      expect(result.source).toBe('cgroup-v1');
      expect(result.throttled).toBeNull();
    });
  });
});

describe('environmentsMatch', () => {
  it('matches an identical fingerprint', () => {
    expect(environmentsMatch(BASE, { ...BASE })).toBe(true);
  });

  it('ignores the patch version of Node', () => {
    expect(environmentsMatch(BASE, { ...BASE, node: 'v20.11.9' })).toBe(true);
  });

  it('does not compare load average', () => {
    // Load average moves every run; including it would report a mismatch on
    // every single comparison and make the gate meaningless.
    expect(environmentsMatch({ ...BASE, loadAvg1m: 0.2 }, { ...BASE, loadAvg1m: 4.8 })).toBe(true);
  });

  it('rejects a different core count', () => {
    expect(environmentsMatch(BASE, { ...BASE, cores: 8 })).toBe(false);
  });

  it('rejects a different CPU model', () => {
    expect(environmentsMatch(BASE, { ...BASE, cpu: 'AMD EPYC 7763' })).toBe(false);
  });

  it('rejects a different Node major', () => {
    expect(environmentsMatch(BASE, { ...BASE, node: 'v18.20.0' })).toBe(false);
  });
});

describe('environmentComparison', () => {
  it('reports every field environmentsMatch compares, on both sides', () => {
    const rows = environmentComparison(BASE, {
      ...BASE,
      cpu: 'AMD EPYC 7763',
      node: 'v20.11.9',
    });
    expect(rows.map((r) => r.field)).toEqual([
      'os',
      'arch',
      'node major',
      'cpu',
      'cores',
      'memoryGB',
    ]);
    const byField = Object.fromEntries(rows.map((r) => [r.field, r]));
    expect(byField.cpu).toEqual({
      field: 'cpu',
      baseline: 'Intel Xeon Platinum 8375C',
      current: 'AMD EPYC 7763',
    });
    // Node is compared by major, exactly like environmentsMatch.
    expect(byField['node major']).toEqual({ field: 'node major', baseline: '20', current: '20' });
    expect(byField.cores).toEqual({ field: 'cores', baseline: '4', current: '4' });
    expect(byField.memoryGB).toEqual({ field: 'memoryGB', baseline: '16', current: '16' });
  });

  it('agrees with environmentsMatch on which fields decide the verdict', () => {
    const diverging = { ...BASE, cpu: 'AMD EPYC 7763' };
    expect(environmentsMatch(BASE, diverging)).toBe(false);
    const rows = environmentComparison(BASE, diverging);
    const differing = rows.filter((r) => r.baseline !== r.current).map((r) => r.field);
    expect(differing).toEqual(['cpu']);
  });
});

describe('throttleStatesMatch', () => {
  it('matches when both sides are unthrottled', () => {
    const a = { ...BASE, cpuQuota: { quotaCpus: 4, throttled: false, source: 'cgroup-v2' as const } };
    const b = { ...BASE, cpuQuota: { quotaCpus: 8, throttled: false, source: 'cgroup-v2' as const } };
    expect(environmentsMatch(a, b)).toBe(true);
  });

  it('rejects a capture taken under a CPU quota', () => {
    const a = { ...BASE, cpuQuota: { quotaCpus: 2, throttled: true, source: 'cgroup-v2' as const } };
    const b = { ...BASE, cpuQuota: { quotaCpus: 4, throttled: false, source: 'cgroup-v2' as const } };
    expect(environmentsMatch(a, b)).toBe(false);
  });

  it('treats unknown as matching unknown', () => {
    expect(
      throttleStatesMatch(
        { ...BASE, cpuQuota: { quotaCpus: null, throttled: null, source: 'unavailable' as const } },
        { ...BASE, cpuQuota: { quotaCpus: null, throttled: null, source: 'unavailable' as const } },
      ),
    ).toBe(true);
  });

  it('treats an absent quota as unknown rather than a mismatch', () => {
    expect(throttleStatesMatch({ ...BASE }, { ...BASE })).toBe(true);
    expect(
      throttleStatesMatch(
        { ...BASE },
        { ...BASE, cpuQuota: { quotaCpus: 2, throttled: true, source: 'cgroup-v2' as const } },
      ),
    ).toBe(true);
  });
});

describe('resolveBaselineHarness', () => {
  it('reads the workflow-level PERFSENSE_REF', () => {
    expect(resolveBaselineHarness({ PERFSENSE_REF: '4751e32' })).toEqual({
      ref: '4751e32',
      source: 'PERFSENSE_REF',
    });
  });

  it('trims whitespace', () => {
    expect(resolveBaselineHarness({ PERFSENSE_REF: '  4751e32  ' }).ref).toBe('4751e32');
  });

  it('marks a local capture as unfingerprinted rather than writing an empty ref', () => {
    const harness = resolveBaselineHarness({});
    expect(harness.ref).toBeNull();
    expect(harness.source).toBe('unavailable');
    if (harness.ref === null) expect(harness.reason).toContain('PERFSENSE_REF');
  });

  it('treats a blank value as absent', () => {
    expect(resolveBaselineHarness({ PERFSENSE_REF: '   ' }).ref).toBeNull();
  });
});

describe('currentHarnessRef', () => {
  it('returns the ref when the workflow sets it', () => {
    expect(currentHarnessRef({ PERFSENSE_REF: 'abc1234' })).toBe('abc1234');
  });

  it('returns null outside the workflow', () => {
    expect(currentHarnessRef({})).toBeNull();
  });
});

describe('harnessComparability', () => {
  const withRef = (ref: string): BaselineData => ({
    schema: 'perfsense-baseline-v2',
    createdAt: '2026-09-20T00:00:00.000Z',
    runs: 5,
    pages: {},
    source: 'test',
    harness: { ref, source: 'PERFSENSE_REF' },
  });

  it('matches when both sides recorded the same revision', () => {
    expect(harnessComparability(withRef('4751e32'), '4751e32')).toBe('match');
  });

  it('mismatches when the baseline was captured by another revision', () => {
    expect(harnessComparability(withRef('53ae5d20'), '4751e32')).toBe('mismatch');
  });

  it('is unknown for a legacy baseline with no harness field', () => {
    const legacy: BaselineData = {
      schema: 'perfsense-baseline-v1',
      createdAt: '2026-09-15T18:04:19.673Z',
      runs: 5,
      pages: {},
      source: 'test',
    };
    expect(harnessComparability(legacy, '4751e32')).toBe('unknown');
  });

  it('is unknown when the baseline was captured locally', () => {
    const local = withRef('x');
    local.harness = { ref: null, source: 'unavailable', reason: 'PERFSENSE_REF is not set.' };
    expect(harnessComparability(local, '4751e32')).toBe('unknown');
  });

  it('is unknown when this run is not in the workflow', () => {
    expect(harnessComparability(withRef('4751e32'), null)).toBe('unknown');
  });
});