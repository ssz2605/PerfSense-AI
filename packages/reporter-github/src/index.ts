import type { CheckStatus } from '@perfsense/core';
import type { CorrelationResult, LikelyCause, RankedEvidence, ConfidenceTier } from '@perfsense/correlation-engine';

export interface CheckResultEntry {
  page: string;
  metric: string;
  status: CheckStatus;
  deltaPercent: number;
  baselineMedian: number;
  currentMedian: number;
  failThreshold: number;
  evidence?: RankedEvidence[];
}

export interface CheckResult {
  results: CheckResultEntry[];
  summary: {
    pass: number;
    warning: number;
    regression: number;
    failed: boolean;
  };
  correlation?: CorrelationResult;
  correlationError?: string;
}

export function generatePRComment(
  result: CheckResult,
  aiAnalysis?: string,
): string {
  const lines: string[] = [];
  const regressions = result.results.filter((r) => r.status === 'REGRESSION');
  const warnings = result.results.filter((r) => r.status === 'WARNING');
  const passes = result.results.filter((r) => r.status === 'PASS');

  lines.push('## PerfSense AI - Performance Report');
  lines.push('');
  lines.push('### Summary');
  lines.push('| Metric | Baseline | Current | Delta | Status |');
  lines.push('|--------|----------|---------|-------|--------|');
  for (const r of result.results) {
    const sign = r.deltaPercent >= 0 ? '+' : '';
    const statusIcon = r.status === 'REGRESSION' ? ':x:' : r.status === 'WARNING' ? ':warning:' : ':white_check_mark:';
    lines.push(`| ${r.metric} | ${r.baselineMedian.toFixed(1)}ms | ${r.currentMedian.toFixed(1)}ms | ${sign}${r.deltaPercent.toFixed(1)}% | ${statusIcon} |`);
  }
  lines.push('');

  if (regressions.length === 0) {
    lines.push('No regressions detected.');
    lines.push('');
    if (aiAnalysis) {
      lines.push('<details>');
      lines.push('<summary>AI Analysis</summary>');
      lines.push('');
      lines.push(aiAnalysis);
      lines.push('');
      lines.push('</details>');
    }
    return lines.join('\n');
  }

  for (const r of regressions) {
    const sign = r.deltaPercent >= 0 ? '+' : '';
    lines.push(`### :x: ${r.metric}: ${sign}${r.deltaPercent.toFixed(1)}%`);
    lines.push('');

    const metricCorrelation = result.correlation?.metrics?.[r.metric.toLowerCase()];
    const lc = metricCorrelation?.likelyCause;

    if (lc) {
      lines.push(`**Likely cause:** ${lc.description}`);
      lines.push('');

      if (lc.sourceLocation) {
        lines.push(`- **Source:** \`${lc.sourceLocation.originalFile}:${lc.sourceLocation.originalLine}\``);
      } else {
        lines.push(`- **Source:** \`${lc.source}\``);
      }

      if (lc.blame) {
        const shortCommit = lc.blame.commit.substring(0, 7);
        lines.push(`- **Commit:** \`${shortCommit}\` by @${lc.blame.author} - "${lc.blame.message}"`);
      }

      if (r.evidence && r.evidence.length > 0) {
        const evidenceDesc = r.evidence.map((e: RankedEvidence) => {
          const typeLabel = e.type === 'trace' ? 'Chrome trace' : e.type === 'network' ? 'Network' : 'Git diff';
          return `${typeLabel} (${e.summary})`;
        }).join(', ');
        lines.push(`- **Evidence:** ${evidenceDesc}`);
      }
    } else {
      lines.push('No likely cause identified.');
    }
    lines.push('');
  }

  // Cross-metric causes
  if (result.correlation?.crossMetricCauses && result.correlation.crossMetricCauses.length > 0) {
    lines.push('### Cross-Metric Causes');
    lines.push('');
    for (const cmc of result.correlation.crossMetricCauses) {
      const affected = cmc.affectedMetrics.join(', ');
      lines.push(`- **${cmc.description}** (affects: ${affected})`);
      if (cmc.sourceLocation) {
        lines.push(`  - Source: \`${cmc.sourceLocation.originalFile}:${cmc.sourceLocation.originalLine}\``);
      }
      if (cmc.blame) {
        const shortCommit = cmc.blame.commit.substring(0, 7);
        lines.push(`  - Commit: \`${shortCommit}\` by @${cmc.blame.author}`);
      }
    }
    lines.push('');
  }

  // AI section (collapsed by default)
  if (aiAnalysis) {
    lines.push('<details>');
    lines.push('<summary>AI Analysis</summary>');
    lines.push('');
    lines.push(aiAnalysis);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Artifacts section
  lines.push('<details>');
  lines.push('<summary>Artifacts</summary>');
  lines.push('');
  lines.push('- [Full results JSON](./perfsense-results.json)');
  lines.push('</details>');

  return lines.join('\n');
}
