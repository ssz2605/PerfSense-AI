import { describe, it, expect } from 'vitest';
import {
  BENCHMARK_MATRIX,
  getFixtureContract,
  getApprovedMetrics,
  isKnownFixture,
  isMetricApproved,
  isMetricUnverified,
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
    expect(getApprovedMetrics('RainbowConnection.html')).toEqual(['projectLoadTime', 'saveTime', 'exportMIDITime', 'memoryDelta', 'retainedHeap']);
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