import os from 'os';
import type { BaselineData, EnvironmentFingerprint } from '@perfsense/core';

/**
 * Computes the environment fingerprint of the current run. Used for the
 * baseline↔current environment gate: comparisons only make sense when both
 * sides are measured on a comparable runner (OS, arch, Node, CPU, physical
 * memory). A mismatch demotes improvements to likely-noise and flags regressions
 * with a caveat.
 */
export function computeEnvironmentFingerprint(
  overrides?: Partial<EnvironmentFingerprint>,
): EnvironmentFingerprint {
  const cpus = os.cpus();
  return {
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    cpu: cpus.length > 0 ? cpus[0].model.trim() : 'unknown',
    cores: cpus.length,
    memoryGB: Math.round(os.totalmem() / (1024 ** 3)),
    runner: process.env.RUNNER_ENVIRONMENT ?? process.env.GITHUB_REPOSITORY ?? undefined,
    coldState: true,
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
    baseline.memoryGB === current.memoryGB
  );
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