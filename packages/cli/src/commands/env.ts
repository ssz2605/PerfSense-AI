import os from 'os';
import fs from 'fs';
import type { BaselineData, BaselineHarness, CpuThrottle, EnvironmentFingerprint } from '@perfsense/core';

/**
 * Parses a cgroup CPU quota into cores. Pure, so the throttle rule can be
 * tested without a cgroup.
 *
 * `v2` is the cgroup v2 `cpu.max` line: either `<quota> <period>` or
 * `max <period>` when unlimited. `quotaUs`/`periodUs` are the cgroup v1
 * `cpu.cfs_quota_us`/`cpu.cfs_period_us` pair. Returns null cores when the
 * quota is absent, unlimited, or unparseable — "unknown", never "unthrottled".
 */
export function parseCpuQuota(
  v2?: string,
  quotaUs?: string,
  periodUs?: string,
): number | null {
  if (typeof v2 === 'string') {
    const parts = v2.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] !== 'max') {
      const quota = Number(parts[0]);
      const period = Number(parts[1]);
      if (Number.isFinite(quota) && Number.isFinite(period) && period > 0) return quota / period;
    }
    // `max <period>` is a real answer: this cgroup is unrestricted.
    if (parts.length >= 2 && parts[0] === 'max') return null;
    return null;
  }
  if (quotaUs !== undefined && periodUs !== undefined) {
    const quota = Number(quotaUs.trim());
    const period = Number(periodUs.trim());
    // cgroup v1 signals "unlimited" with a quota of -1.
    if (!Number.isFinite(quota) || quota <= 0) return null;
    if (!Number.isFinite(period) || period <= 0) return null;
    return quota / period;
  }
  return null;
}

function readIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Reads the CPU quota of the current cgroup. A quota below the visible core
 * count means the runner is CPU-constrained, which is the one environmental
 * fact that makes a whole capture untrustworthy: every metric inflates at
 * once, which is indistinguishable from a real regression. Best-effort — on a
 * host without cgroup accounting the answer is null (unknown), never false.
 */
export function detectCpuThrottle(cores?: number): CpuThrottle {
  const visible = cores ?? os.cpus().length;
  const v2 = readIfPresent('/sys/fs/cgroup/cpu.max');
  let quotaCpus = parseCpuQuota(v2, undefined, undefined);
  let source: CpuThrottle['source'] = v2 !== undefined ? 'cgroup-v2' : 'unavailable';

  if (v2 === undefined) {
    const v1Quota = readIfPresent('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
    const v1Period = readIfPresent('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
    if (v1Quota !== undefined && v1Period !== undefined) {
      quotaCpus = parseCpuQuota(undefined, v1Quota, v1Period);
      source = 'cgroup-v1';
    }
  }

  // Both cgroup versions answer the same question the same way. Deriving
  // `throttled` only on the v2 path meant a v1 host reported "unknown" even
  // with a quota in hand, so the contention check silently did nothing on every
  // v1 host — the one case where a runner is most likely to be constrained.
  if (quotaCpus === null) return { quotaCpus: null, throttled: null, source };
  return { quotaCpus, throttled: visible > 0 && quotaCpus < visible, source };
}

/**
 * Computes the environment fingerprint of the current run. Used for the
 * baseline↔current environment gate: comparisons only make sense when both
 * sides are measured on a comparable runner (OS, arch, Node, CPU, physical
 * memory, CPU quota). A mismatch demotes improvements to likely-noise and flags
 * regressions with a caveat.
 */
export function computeEnvironmentFingerprint(
  overrides?: Partial<EnvironmentFingerprint>,
): EnvironmentFingerprint {
  const cpus = os.cpus();
  // win32 reports a zero load average unconditionally; recording it would look
  // like a real measurement of an idle machine.
  const loadAvg1m = process.platform === 'win32' ? undefined : os.loadavg()[0];
  return {
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    cpu: cpus.length > 0 ? cpus[0].model.trim() : 'unknown',
    cores: cpus.length,
    memoryGB: Math.round(os.totalmem() / (1024 ** 3)),
    runner: process.env.RUNNER_ENVIRONMENT ?? process.env.GITHUB_REPOSITORY ?? undefined,
    coldState: true,
    loadAvg1m: loadAvg1m !== undefined ? Math.round(loadAvg1m * 100) / 100 : undefined,
    cpuQuota: detectCpuThrottle(cpus.length),
    ...overrides,
  };
}

/** Reads the env fingerprint recorded in a baseline, or null for legacy v1. */
export function baselineEnvironment(baseline: BaselineData): EnvironmentFingerprint | null {
  return baseline.env ?? null;
}

/**
 * Compares two environment fingerprints. Returns null when the baseline side is
 * missing (legacy v1 baseline) — the comparison is unknowable, so callers must
 * treat improvements as unverifiable instead of trusting them.
 *
 * `loadAvg1m` is deliberately excluded: it moves on every run and would report
 * a mismatch on every comparison. The cgroup CPU quota is included, because a
 * quota below the visible core count means the two sides ran under different
 * CPU budgets — that is a real, stable difference and it is the one that makes
 * a capture untrustworthy.
 */
export function environmentsMatch(
  baseline: EnvironmentFingerprint,
  current: EnvironmentFingerprint,
): boolean {
  // Compare the stable subset only: exact versions drift between baseline day
  // and PR day without meaningfully changing the runner.
  const nodeMajor = (v: string): string => v.replace(/^v/, '').split('.')[0];
  return (
    baseline.os === current.os &&
    baseline.arch === current.arch &&
    nodeMajor(baseline.node) === nodeMajor(current.node) &&
    baseline.cpu === current.cpu &&
    baseline.cores === current.cores &&
    baseline.memoryGB === current.memoryGB &&
    throttleStatesMatch(baseline, current)
  );
}

/** True when both sides report the same CPU-constrained state; unknown matches unknown. */
export function throttleStatesMatch(
  baseline: EnvironmentFingerprint,
  current: EnvironmentFingerprint,
): boolean {
  const a = baseline.cpuQuota?.throttled;
  const b = current.cpuQuota?.throttled;
  if (a === null || a === undefined || b === null || b === undefined) return true;
  return a === b;
}

/**
 * Age of the baseline in whole days, or null when the baseline carries no
 * generation timestamp (legacy v1 schemas still write `createdAt`).
 */
export function baselineAgeDays(
  baseline: BaselineData,
  now: number = Date.now(),
): number | null {
  const ts = baseline.generatedAt ?? baseline.createdAt;
  if (!ts) return null;
  const parsed = Date.parse(ts);
  if (isNaN(parsed)) return null;
  return Math.max(0, Math.floor((now - parsed) / 86_400_000));
}

/**
 * Resolves which PerfSense revision is producing the current baseline. The
 * workflow exports `PERFSENSE_REF` at the workflow level, so every step — not
 * just the checkout — sees it. Outside the workflow the variable is absent, and
 * that is recorded as `unavailable` rather than as an absent field: an absent
 * field is indistinguishable from a baseline written by an older harness.
 */
export function resolveBaselineHarness(
  env: NodeJS.ProcessEnv = process.env,
): BaselineHarness {
  const ref = (env.PERFSENSE_REF ?? '').trim();
  if (ref) return { ref, source: 'PERFSENSE_REF' };
  return {
    ref: null,
    source: 'unavailable',
    reason: 'PERFSENSE_REF is not set; this capture did not run from the PerfSense workflow.',
  };
}

/** The PerfSense revision of the current process, or null outside the workflow. */
export function currentHarnessRef(env: NodeJS.ProcessEnv = process.env): string | null {
  const ref = (env.PERFSENSE_REF ?? '').trim();
  return ref ? ref : null;
}

export type HarnessComparability =
  /** Both sides recorded a revision and they agree. */
  | 'match'
  /** Both sides recorded a revision and they differ: the two sides are not comparable. */
  | 'mismatch'
  /** At least one side has no revision, so comparability cannot be established. */
  | 'unknown';

/**
 * Decides whether a baseline and the current run were produced by the same
 * PerfSense revision. Two harnesses can define different metric sets and time
 * the same metric differently — including collecting a metric the other side
 * dropped entirely — so a delta between them measures the harness, not the
 * code. That difference is unfalsifiable from the numbers, which is why it is
 * gated rather than reported as a caveat.
 */
export function harnessComparability(
  baseline: BaselineData,
  currentRef: string | null,
): HarnessComparability {
  const baselineRef = baseline.harness?.ref ?? null;
  if (!baselineRef || !currentRef) return 'unknown';
  return baselineRef === currentRef ? 'match' : 'mismatch';
}