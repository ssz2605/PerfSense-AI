import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildSystemPrompt, parseAIResponse, generateAIAnalysis, buildEvidenceBriefing, buildOllamaUserMessage } from './index';
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

/** A regression the correlation engine could not attribute to any changed file. */
const unattributedCorrelation: CorrelationResult = {
  metrics: {
    projectLoadTime: {
      regression: { metric: 'projectLoadTime', baselineMedian: 11696.8, currentMedian: 13997.2, deltaPercent: 19.7, pValue: 0.009, effectSize: 0.4, confidenceInterval: [11000, 14000] },
      evidence: [],
      likelyCause: null,
      filteredEvidence: 0,
    },
  },
  crossMetricCauses: [],
  summary: { totalRegressions: 1, metricsWithCause: 0, metricsInconclusive: 1 },
};

describe('buildSystemPrompt', () => {
  it('returns a string with correlation data embedded', () => {
    const prompt = buildSystemPrompt(mockCorrelation, { commit: 'abc123', message: 'fix', author: 'dev', filesChanged: ['a.ts'] });
    expect(prompt).toContain('playbackLatency');
    expect(prompt).toContain('abc123');
  });
});

describe('evidence briefing', () => {
  it('reports the attribution tier and location when a cause was found', () => {
    const briefing = buildEvidenceBriefing(mockCorrelation);
    expect(briefing).toContain('playbackLatency');
    expect(briefing).toContain('direct');
    expect(briefing).toContain('audio-engine.js');
    expect(briefing).not.toContain('none established');
  });

  it('states plainly that no code-path evidence exists when there is no cause', () => {
    const briefing = buildEvidenceBriefing(unattributedCorrelation);
    expect(briefing).toContain('projectLoadTime');
    expect(briefing).toContain('`none`');
    expect(briefing).toContain('no changed file was found on the measured code path');
  });

  it('forbids inventing a cause and separates significance from causation', () => {
    const prompt = buildSystemPrompt(unattributedCorrelation, { commit: 'abc', message: '', author: '', filesChanged: ['js/loader.js'] });
    // The absence of evidence must be stated as an input, not inferred.
    expect(prompt).toContain('`none`');
    expect(prompt).toContain('no direct code-path correlation was established');
    expect(prompt).toContain('do NOT invent a root cause');
    expect(prompt).toContain('do NOT claim or imply that this PR caused the regression');
    expect(prompt).toContain('measurement or environment differences are possible');
    expect(prompt).toContain('Statistical significance is NOT causal evidence');
    expect(prompt).toContain('Mann-Whitney');
    // The changed-files list is still supplied, but is not enough on its own.
    expect(prompt).toContain('js/loader.js');
  });

  it('permits naming the file when direct evidence exists', () => {
    const prompt = buildSystemPrompt(mockCorrelation, { commit: 'abc', message: '', author: '', filesChanged: ['js/loader.js'] });
    expect(prompt).toContain('Evidence Level');
    expect(prompt).toContain('you may name the attributed file/line');
  });

  it('carries the tier and the rules into the ollama user turn', () => {
    const message = buildOllamaUserMessage({
      correlation: unattributedCorrelation,
      gitContext: { commit: 'abc', message: '', author: '', filesChanged: [] },
      systemPrompt: '',
    });
    expect(message).toContain('`none`');
    expect(message).toContain('Statistical significance is NOT causal evidence');
  });

  it('still carries the rules when the prompt template is unavailable', () => {
    // `build` must copy src/prompts into dist; if that ever regresses, the
    // template silently disappears at runtime. The fallback must not silently
    // drop the evidence level with it.
    const resolved = path.resolve(__dirname, 'prompts', 'regression-analysis.md');
    const backup = fs.readFileSync(resolved);
    fs.rmSync(resolved);
    try {
      const prompt = buildSystemPrompt(unattributedCorrelation, {
        commit: 'abc',
        message: '',
        author: '',
        filesChanged: ['js/loader.js'],
      });
      expect(prompt).toContain('`none`');
      expect(prompt).toContain('Statistical significance is NOT causal evidence');
      expect(prompt).toContain('do NOT invent a root cause');
      expect(prompt).toContain('projectLoadTime');
    } finally {
      fs.writeFileSync(resolved, backup);
    }
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
