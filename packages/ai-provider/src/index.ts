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
  ollama: 'llama3',
};

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
  const template = loadPromptTemplate('regression-analysis.md');
  if (!template) {
    return 'Analyze the following performance regression and provide optimization suggestions.';
  }
  return renderPrompt(template, {
    correlationJson: JSON.stringify(correlation, null, 2),
    gitContext: JSON.stringify(gitContext, null, 2),
  });
}

async function callOpenAI(
  systemPrompt: string,
  config: AIProviderConfig,
): Promise<AIOutput> {
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key not provided');
  }
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  const response = await fetch(`${baseUrl}/chat/completions`, {
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
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as any;
  const content = data.choices?.[0]?.message?.content || '';
  return parseAIResponse(content);
}

async function callAnthropic(
  systemPrompt: string,
  config: AIProviderConfig,
): Promise<AIOutput> {
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Anthropic API key not provided');
  }
  const baseUrl = config.baseUrl || 'https://api.anthropic.com/v1';
  const response = await fetch(`${baseUrl}/messages`, {
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
      messages: [{ role: 'user', content: 'Analyze the regression data and provide optimization suggestions.' }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json() as any;
  const content = data.content?.[0]?.text || '';
  return parseAIResponse(content);
}

async function callOllama(
  systemPrompt: string,
  config: AIProviderConfig,
): Promise<AIOutput> {
  const baseUrl = config.baseUrl || 'http://localhost:11434';
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model || DEFAULT_MODELS.ollama,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Analyze the regression data and provide optimization suggestions.' },
      ],
      stream: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
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
      return callAnthropic(systemPrompt, config);
    case 'ollama':
      return callOllama(systemPrompt, config);
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
