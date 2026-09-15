import { describe, it, expect } from 'vitest';
import {
  BENCHMARK_MATRIX,
  getFixtureContract,
  getApprovedMetrics,
  isKnownFixture,
  isMetricApproved,
  isMetricUnverified,
  isMetricWarnOnly,
  formatFixtureName,
  formatMetricValue,
  formatDeltaPercent,
} from './index';

describe('Benchmark Matrix contract', () => {
  it('covers every approved fixture exactly once', () => {
    const fixtures = BENCHMARK_MATRIX.map((c) => c.fixture);
    expect(fixtures).toEqual([
      'index.html',
      'RainbowConnection.html',
      'Frere-Jacques.html',
      'musical-tree.html',
      'ascending-notes-color-spiral.html',
      'crabcanon-plot.html',
    ]);
    expect(new Set(fixtures.map((f) => f.toLowerCase())).size).toBe(fixtures.length);
  });

  it('defines the approved metric sets per fixture', () => {
    expect(getApprovedMetrics('index.html')).toEqual(['bootstrapTotal', 'initTotal', 'heapAfterBoot']);
    expect(getApprovedMetrics('RainbowConnection.html')).toEqual(['projectLoadTime', 'saveTime', 'exportMIDITime']);
    expect(getApprovedMetrics('Frere-Jacques.html')).toEqual(['callbackLatencyMean', 'callbackLatencyMax', 'cumulativeDrift', 'voiceOnsetError']);
    expect(getApprovedMetrics('musical-tree.html')).toEqual(['maxQueueDepth', 'executionTime', 'memoryDelta', 'retainedHeap', 'maxDepth']);
    expect(getApprovedMetrics('ascending-notes-color-spiral.html')).toEqual(['executionTime', 'maxDepth', 'blocksExecuted']);
    expect(getApprovedMetrics('crabcanon-plot.html')).toEqual(['scheduleLagMean', 'scheduleLagMax']);
  });

  it('rejects metrics that are not part of the matrix for a fixture', () => {
    // Frère Jacques must not show unrelated metrics.
    expect(isMetricApproved('Frere-Jacques.html', 'projectLoadTime')).toBe(false);
    expect(isMetricApproved('Frere-Jacques.html', 'executionTime')).toBe(false);
    expect(isMetricApproved('Frere-Jacques.html', 'maxQueueDepth')).toBe(false);
    expect(isMetricApproved('Frere-Jacques.html', 'blocksExecuted')).toBe(false);
    expect(isMetricApproved('Frere-Jacques.html', 'maxDepth')).toBe(false);
    expect(isMetricApproved('Frere-Jacques.html', 'memoryDelta')).toBe(false);
    expect(isMetricApproved('Frere-Jacques.html', 'retainedHeap')).toBe(false);
    // Rainbow owns load/save/export only; the memory metrics belong to
    // musical-tree (the only fixture that records them during playback).
    expect(isMetricApproved('RainbowConnection.html', 'memoryDelta')).toBe(false);
    expect(isMetricApproved('RainbowConnection.html', 'retainedHeap')).toBe(false);
    // maxActionDepth is not in the approved matrix anywhere.
    expect(isMetricApproved('musical-tree.html', 'maxActionDepth')).toBe(false);
    // crabcanon-plot only exposes its two schedule-lag metrics.
    expect(getApprovedMetrics('crabcanon-plot.html')).toEqual(['scheduleLagMean', 'scheduleLagMax']);
  });

  it('is case-insensitive for fixture and metric names', () => {
    expect(isMetricApproved('rainbowconnection.html', 'EXPORTMITITIME')).toBe(false);
    expect(isMetricApproved('rainbowconnection.html', 'exportMIDITime')).toBe(true);
    expect(getFixtureContract('RAINBOWCONNECTION.HTML')?.displayName).toBe('Rainbow Connection');
  });

  it('marks maxDepth as unverified for the fixtures that contain it', () => {
    expect(isMetricUnverified('musical-tree.html', 'maxDepth')).toBe(true);
    expect(isMetricUnverified('ascending-notes-color-spiral.html', 'maxDepth')).toBe(true);
    expect(isMetricUnverified('musical-tree.html', 'maxQueueDepth')).toBe(false);
    expect(isMetricUnverified('RainbowConnection.html', 'exportMIDITime')).toBe(false);
  });

  it('marks the warn-only metrics per fixture', () => {
    expect(isMetricWarnOnly('Frere-Jacques.html', 'callbackLatencyMean')).toBe(true);
    expect(isMetricWarnOnly('Frere-Jacques.html', 'callbackLatencyMax')).toBe(true);
    expect(isMetricWarnOnly('Frere-Jacques.html', 'cumulativeDrift')).toBe(true);
    expect(isMetricWarnOnly('Frere-Jacques.html', 'voiceOnsetError')).toBe(true);
    expect(isMetricWarnOnly('musical-tree.html', 'memoryDelta')).toBe(true);
    expect(isMetricWarnOnly('musical-tree.html', 'retainedHeap')).toBe(true);
    // Rainbow no longer lists the memory metrics: not approved here means not
    // warn-only here either (musical-tree is their only home).
    expect(isMetricWarnOnly('RainbowConnection.html', 'memoryDelta')).toBe(false);
    expect(isMetricWarnOnly('RainbowConnection.html', 'retainedHeap')).toBe(false);
    // Verified metrics are not warn-only, and neither is scheduleLag.
    expect(isMetricWarnOnly('index.html', 'bootstrapTotal')).toBe(false);
    expect(isMetricWarnOnly('RainbowConnection.html', 'projectLoadTime')).toBe(false);
    expect(isMetricWarnOnly('crabcanon-plot.html', 'scheduleLagMean')).toBe(false);
    expect(isMetricWarnOnly('crabcanon-plot.html', 'scheduleLagMax')).toBe(false);
    // A metric listed only in another fixture's set is not simply warn-only:
    // it is not approved at all for this fixture.
    expect(isMetricApproved('index.html', 'memoryDelta')).toBe(false);
  });

  it('rejects every metric outside its fixture list (strict contract)', () => {
    // No metric may appear outside its approved list: the full registry of
    // metrics must be rejected for fixtures that do not list them.
    const allMetrics = [
      'bootstrapTotal', 'initTotal', 'heapAfterBoot',
      'projectLoadTime', 'saveTime', 'exportMIDITime',
      'callbackLatencyMean', 'callbackLatencyMax', 'cumulativeDrift', 'voiceOnsetError',
      'maxQueueDepth', 'executionTime', 'blocksExecuted', 'maxDepth',
      'memoryDelta', 'retainedHeap', 'scheduleLagMean', 'scheduleLagMax',
    ];
    for (const contract of BENCHMARK_MATRIX) {
      for (const metric of allMetrics) {
        const approved = contract.metrics.some((m) => m.toLowerCase() === metric.toLowerCase());
        expect(isMetricApproved(contract.fixture, metric)).toBe(approved);
      }
    }
    // maxActionDepth is not part of the contract anywhere.
    expect(isMetricApproved('musical-tree.html', 'maxActionDepth')).toBe(false);
  });

  it('formats display names and values professionally', () => {
    expect(formatFixtureName('RainbowConnection.html')).toBe('Rainbow Connection');
    expect(formatFixtureName('Frere-Jacques.html')).toBe('Frère Jacques');
    expect(formatFixtureName('unknown.html')).toBe('unknown.html');
    expect(formatMetricValue(5370.46, 'bootstrapTotal')).toBe('5370.5 ms');
    // Heap is captured in bytes and presented in MB.
    expect(formatMetricValue(47400000, 'heapAfterBoot')).toBe('47.4 MB');
    expect(formatMetricValue(0, 'memoryDelta')).toBe('0 B');
    expect(formatMetricValue(1, 'maxDepth')).toBe('1');
    expect(formatMetricValue(42, 'blocksExecuted')).toBe('42');
    expect(formatDeltaPercent(159.4)).toBe('+159.4%');
    expect(formatDeltaPercent(-3.01)).toBe('-3.0%');
  });
});