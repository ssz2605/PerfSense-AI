import fs from 'fs';
import path from 'path';
import type { CorrelationResult } from '@perfsense/correlation-engine';

export type AIProvider = 'openai' | 'anthropic' | 'ollama';

export interface GitContext {
  commit: string;
  message: string;
  author: string;
  filesChanged: string[];
}

export interface AIInput {
  correlation: CorrelationResult;
  gitContext: GitContext;
  systemPrompt: string;
}

export interface AIOutput {
  explanation: string;
  suggestions: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface AIProviderConfig {
  provider: AIProvider;
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

const DEFAULT_MODELS: Record<AIProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-haiku-20240307',
  ollama: 'llama3.1:8b',
};

/** Hard ceiling on a single AI request, so a hung provider cannot stall the report. */
export const AI_TIMEOUT_MS = 60_000;

/**
 * `fetch` with a hard timeout and a message that names the cause. Without this
 * a hung provider fails at the job-level timeout with a generic abort that the
 * report can only describe as "something went wrong".
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(AI_TIMEOUT_MS) });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`AI request timed out after ${AI_TIMEOUT_MS / 1000}s (${url})`);
    }
    throw err;
  }
}

function loadPromptTemplate(name: string): string {
  const promptDir = path.join(__dirname, 'prompts');
  const filePath = path.join(promptDir, name);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return '';
}

function renderPrompt(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

export function buildSystemPrompt(correlation: CorrelationResult, gitContext: GitContext): string {
  const briefing = buildEvidenceBriefing(correlation);
  const template = loadPromptTemplate('regression-analysis.md');
  if (!template) {
    // Never degrade to a bare instruction. If the prompt file is missing the
    // model still gets the data, the evidence level and the rules — losing the
    // template may cost formatting, but losing the rules reintroduces exactly
    // the invented-root-cause failure this prompt exists to prevent.
    return (
      'You are an expert web performance engineer analyzing a regression.\n\n' +
      `## Evidence Level\n${briefing}\n\n${EVIDENCE_RULES}\n\n` +
      `## Regression Data\n${JSON.stringify(correlation, null, 2)}\n\n` +
      `## Git Context\n${JSON.stringify(gitContext, null, 2)}\n`
    );
  }
  return renderPrompt(template, {
    correlationJson: JSON.stringify(correlation, null, 2),
    gitContext: JSON.stringify(gitContext, null, 2),
    evidenceBriefing: briefing,
    evidenceRules: EVIDENCE_RULES,
  });
}

/**
 * Per-metric statement of what evidence level the deterministic correlation
 * engine actually reached, plus what that permits the model to claim.
 *
 * The model is otherwise left to infer causality from a list of changed files,
 * which it reliably does by inventing one. Passing the tier explicitly makes
 * "no direct code-path evidence was established" an input rather than something
 * the model has to notice, so the absence of a cause is reported as an absence
 * instead of being filled in.
 */
export function buildEvidenceBriefing(correlation: CorrelationResult): string {
  const lines: string[] = [];
  for (const [metric, mc] of Object.entries(correlation.metrics)) {
    const cause = mc.likelyCause;
    const at = cause?.sourceLocation?.originalLine;
    const where = cause ? `\`${cause.source}${at ? `:${at}` : ''}\`` : 'none';
    if (cause) {
      lines.push(`- ${metric}: evidence tier \`${cause.confidence}\`, attributed to ${where}.`);
    } else {
      lines.push(`- ${metric}: evidence tier \`none\` - no changed file was found on the measured code path.`);
    }
  }
  if (lines.length === 0) lines.push('- (no regressions were correlated)');
  return lines.join('\n');
}

/**
 * The rule that separates a measurement from a cause, restated in the prompt so
 * statistical significance is never read as proof of causation.
 */
export const EVIDENCE_RULES = [
  'Statistical significance is NOT causal evidence. A significant p-value (for example a',
  'Mann-Whitney result below 0.05) means the two distributions differ; it says nothing about',
  'which change produced the difference. Never present it as proof that a particular code',
  'change caused the regression.',
  '',
  'For a metric whose evidence tier is `none`:',
  '- state explicitly that no direct code-path correlation was established for it',
  '- do NOT invent a root cause, and do NOT name a file, line or change as the cause',
  '- do NOT claim or imply that this PR caused the regression',
  '- note that measurement or environment differences are possible explanations',
  '- recommend verifying against a compatible baseline, or profiling, as a diagnostic',
  '  next step only',
  '',
  'For a metric that has an evidence tier:',
  '- you may name the attributed file/line and explain why that change is consistent with',
  '  the observed direction and magnitude',
  '- keep what the diff shows visibly separate from what you are inferring',
  '',
  'For every metric:',
  '- do NOT offer generic optimization advice. "Consider code splitting, caching, or',
  '  profiling" is not an analysis. Name the specific operation and location, or say you',
  '  have no evidence and stop.',
].join('\n');

async function callOpenAI(
  systemPrompt: string,
  config: AIProviderConfig,
): Promise<AIOutput> {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key not provided');
  }
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODELS.openai,
      messages: [{ role: 'system', content: systemPrompt }],
      temperature: 0.3,
      max_tokens: 2000,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI API error: HTTP ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as any;
  const content = data.choices?.[0]?.message?.content || '';
  return parseAIResponse(content);
}

async function callAnthropic(
  systemPrompt: string,
  config: AIProviderConfig,
  input: AIInput,
): Promise<AIOutput> {
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Anthropic API key not provided');
  }
  const baseUrl = config.baseUrl || 'https://api.anthropic.com/v1';
  const response = await fetchWithTimeout(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODELS.anthropic,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: buildEvidenceRequest(input) }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic API error: HTTP ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as any;
  const content = data.content?.[0]?.text || '';
  return parseAIResponse(content);
}

/** User turn for providers that follow the user message more reliably than the system prompt. */
function buildEvidenceRequest(input: AIInput): string {
  return (
    'Analyze the regression data in the system prompt.\n\n' +
    `Evidence level reached by the deterministic engine:\n${buildEvidenceBriefing(input.correlation)}\n\n` +
    `${EVIDENCE_RULES}\n\n` +
    'Respond now; do not ask for more data.'
  );
}

export function buildOllamaUserMessage(input: AIInput): string {
  // Small local models follow the user turn far more reliably than the system
  // prompt, so repeat a compact data summary here instead of relying on the
  // system message alone. This prevents responses like "I don't see any data".
  const lines: string[] = [];
  const summary = input.correlation.summary;
  if (summary) {
    lines.push(
      `Summary: ${summary.totalRegressions} regression(s); ${summary.metricsWithCause} with a deterministic cause; ${summary.metricsInconclusive} without one.`,
    );
  }
  for (const [metric, m] of Object.entries(input.correlation.metrics)) {
    const r = m.regression;
    if (!r) continue;
    lines.push(
      `- ${metric}: ${r.deltaPercent > 0 ? '+' : ''}${r.deltaPercent.toFixed(1)}% ` +
        `(baseline ${r.baselineMedian} -> current ${r.currentMedian}) ` +
        `p=${r.pValue.toFixed(3)} effect=${r.effectSize.toFixed(2)}`,
    );
  }
  lines.push('', `Evidence level:`, buildEvidenceBriefing(input.correlation), '', EVIDENCE_RULES);
  const cross = input.correlation.crossMetricCauses;
  if (cross.length > 0) {
    lines.push(`Cross-metric causes: ${JSON.stringify(cross)}`);
  }
  if (input.gitContext.filesChanged.length > 0) {
    lines.push(`Files changed in this PR: ${input.gitContext.filesChanged.join(', ')}`);
  }
  lines.push(
    'Analyze the regression data above now. Do not ask the user for more data.',
  );
  return lines.join('\n');
}

async function callOllama(
  systemPrompt: string,
  config: AIProviderConfig,
  input: AIInput,
): Promise<AIOutput> {
  const baseUrl = config.baseUrl || 'http://localhost:11434';
  const response = await fetchWithTimeout(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODELS.ollama,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildOllamaUserMessage(input) },
      ],
      stream: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama API error: HTTP ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as any;
  const content = data.message?.content || '';
  return parseAIResponse(content);
}

export function parseAIResponse(content: string): AIOutput {
  const sections = content.split(/## /g);
  let explanation = content;
  const suggestions: string[] = [];
  for (const section of sections) {
    const lines = section.trim().split('\n');
    if (lines.length > 1 && /^\d+\./.test(lines[1] || '')) {
      for (const line of lines.slice(1)) {
        const match = line.match(/^\d+\.\s+(.+)/);
        if (match) suggestions.push(match[1]);
      }
    }
  }
  const hasDetailed = content.length > 200;
  const hasSuggestions = suggestions.length > 0;
  const confidence: 'high' | 'medium' | 'low' = hasDetailed && hasSuggestions ? 'high' : hasDetailed ? 'medium' : 'low';
  return { explanation, suggestions, confidence };
}

export async function analyzeRegression(
  input: AIInput,
  config: AIProviderConfig,
): Promise<AIOutput> {
  const systemPrompt = input.systemPrompt || buildSystemPrompt(input.correlation, input.gitContext);
  switch (config.provider) {
    case 'openai':
      return callOpenAI(systemPrompt, config);
    case 'anthropic':
      return callAnthropic(systemPrompt, config, input);
    case 'ollama':
      return callOllama(systemPrompt, config, input);
    default:
      throw new Error(`Unsupported AI provider: ${config.provider}`);
  }
}

export async function generateAIAnalysis(
  correlation: CorrelationResult,
  gitContext: GitContext,
  config: AIProviderConfig,
): Promise<AIOutput | null> {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey && config.provider !== 'ollama') {
    return null;
  }
  const effectiveConfig: AIProviderConfig = {
    ...config,
    apiKey: apiKey || '',
  };
  const systemPrompt = buildSystemPrompt(correlation, gitContext);
  return analyzeRegression({ correlation, gitContext, systemPrompt }, effectiveConfig);
}
