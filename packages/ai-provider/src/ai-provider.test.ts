import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, parseAIResponse, generateAIAnalysis } from './index';
import type { CorrelationResult } from '@perfsense/correlation-engine';

const mockCorrelation: CorrelationResult = {
  metrics: {
    playbackLatency: {
      regression: { metric: 'playbackLatency', baselineMedian: 2.8, currentMedian: 38.9, deltaPercent: 1289, pValue: 0.0001, effectSize: 1.0, confidenceInterval: [35, 42] },
      evidence: [],
      likelyCause: { description: 'Main thread blocked 42ms', source: 'audio-engine.js:87', confidence: 'direct' as any, evidenceIds: ['trace-1'] },
      filteredEvidence: 0,
    },
  },
  crossMetricCauses: [],
  summary: { totalRegressions: 1, metricsWithCause: 1, metricsInconclusive: 0 },
};

describe('buildSystemPrompt', () => {
  it('returns a string with correlation data embedded', () => {
    const prompt = buildSystemPrompt(mockCorrelation, { commit: 'abc123', message: 'fix', author: 'dev', filesChanged: ['a.ts'] });
    expect(prompt).toContain('playbackLatency');
    expect(prompt).toContain('abc123');
  });
});

describe('parseAIResponse', () => {
  it('parses explanation text', () => {
    const result = parseAIResponse('This is an analysis of the regression.');
    expect(result.explanation).toBe('This is an analysis of the regression.');
    expect(result.suggestions).toEqual([]);
  });

  it('extracts numbered suggestions', () => {
    const text = '## Suggestions\n1. Move layout calculation to rAF\n2. Pre-allocate audio buffers';
    const result = parseAIResponse(text);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });
});

describe('generateAIAnalysis', () => {
  it('returns null when no API key and not ollama', async () => {
    const result = await generateAIAnalysis(mockCorrelation, { commit: 'abc', message: 'test', author: 'dev', filesChanged: [] }, { provider: 'openai', apiKey: '', model: 'gpt-4o-mini' });
    expect(result).toBeNull();
  });

  it('returns null when no API key via env fallback', async () => {
    const oldKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const result = await generateAIAnalysis(mockCorrelation, { commit: 'abc', message: 'test', author: 'dev', filesChanged: [] }, { provider: 'openai', model: 'gpt-4o-mini' });
    expect(result).toBeNull();
    if (oldKey) process.env.OPENAI_API_KEY = oldKey;
  });
});
