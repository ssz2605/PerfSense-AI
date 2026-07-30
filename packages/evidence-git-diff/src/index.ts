import type { Evidence, EvidenceHighlight } from '@perfsense/core';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

function makeId(): string {
  return 'git-' + crypto.randomBytes(4).toString('hex') + '-' + Date.now().toString(36);
}

interface ChangeEntry {
  file: string;
  status: string;
  insertions: number;
  deletions: number;
}

interface DiffResult {
  filesChanged: number;
  additions: number;
  deletions: number;
  changes: ChangeEntry[];
  bundleAffecting: string[];
  dependencyChanges: string[];
}

function runGitDiff(cwd: string): DiffResult | null {
  try {
    const numstatOut = execSync('git diff HEAD~1 --numstat', { cwd, encoding: 'utf-8', timeout: 5000 });

    const lines = numstatOut.trim().split('\n').filter((l: string) => l.length > 0);
    const changes: ChangeEntry[] = lines.map((line: string) => {
      const parts = line.split('\t');
      return {
        insertions: parseInt(parts[0], 10) || 0,
        deletions: parseInt(parts[1], 10) || 0,
        file: parts[2] || '',
        status: 'modified',
      };
    });

    const totalAdditions = changes.reduce((s: number, c: ChangeEntry) => s + c.insertions, 0);
    const totalDeletions = changes.reduce((s: number, c: ChangeEntry) => s + c.deletions, 0);

    const bundleAffecting = changes
      .filter((c: ChangeEntry) => /\.(js|jsx|ts|tsx|css|scss|html|json|wasm)$/i.test(c.file))
      .map((c: ChangeEntry) => c.file);

    const dependencyChanges: string[] = [];
    const pkgChange = changes.find((c: ChangeEntry) => c.file === 'package.json' || c.file.endsWith('/package.json'));
    if (pkgChange) {
      try {
        execSync('git diff HEAD~1 -- package.json', { cwd, encoding: 'utf-8', timeout: 3000 })
          .split('\n')
          .filter((l: string) => /^\+\s+"/.test(l))
          .forEach((line: string) => {
            const match = line.match(/"([^"]+)":\s*"([^"]+)"/);
            if (match) dependencyChanges.push(`${match[1]}@${match[2]}`);
          });
      } catch {
        // ignore
      }
    }

    return {
      filesChanged: changes.length,
      additions: totalAdditions,
      deletions: totalDeletions,
      changes,
      bundleAffecting,
      dependencyChanges,
    };
  } catch {
    return null;
  }
}

export function collectGitDiffEvidence(metricName: string): Evidence {
  const startTime = Date.now();
  const cwd = process.cwd();
  const result = runGitDiff(cwd);

  if (!result) {
    return {
      id: makeId(),
      type: 'git-diff',
      metricName,
      timestamp: startTime,
      confidence: 0,
      summary: 'Git diff not available (not a git repo or no previous commit)',
      highlights: [{ label: 'Git diff', value: 'Not available', severity: 'info' as const }],
    };
  }

  const highlights: EvidenceHighlight[] = [];

  highlights.push({
    label: 'Files changed',
    value: `${result.filesChanged} files (+${result.additions}/-${result.deletions} lines)`,
    severity: result.filesChanged > 10 ? 'warning' : 'info',
  });

  if (result.bundleAffecting.length > 0) {
    highlights.push({
      label: 'Bundle-affecting changes',
      value: result.bundleAffecting.join(', '),
      severity: 'warning',
    });
  }

  if (result.dependencyChanges.length > 0) {
    highlights.push({
      label: 'Dependency changes',
      value: result.dependencyChanges.join(', '),
      severity: 'critical',
    });
  }

  if (result.changes.length > 0) {
    const bigChanges = result.changes
      .filter((c: ChangeEntry) => c.insertions + c.deletions > 50)
      .map((c: ChangeEntry) => `${c.file} (+${c.insertions}/-${c.deletions})`);
    if (bigChanges.length > 0) {
      highlights.push({
        label: 'Largest changes',
        value: bigChanges.join('; '),
        severity: 'warning',
      });
    }
  }

  let summary = `Git diff: ${result.filesChanged} files changed`;
  if (result.dependencyChanges.length > 0) {
    summary += `, ${result.dependencyChanges.length} dep(s) changed`;
  }
  if (result.bundleAffecting.length > 0) {
    summary += `, ${result.bundleAffecting.length} bundle-affecting file(s)`;
  }

  return {
    id: makeId(),
    type: 'git-diff',
    metricName,
    timestamp: startTime,
    confidence: result.changes.length > 0 ? 1 : 0.5,
    summary,
    highlights,
    details: {
      filesChanged: result.filesChanged,
      additions: result.additions,
      deletions: result.deletions,
      changes: result.changes.length > 20 ? result.changes.slice(0, 20) : result.changes,
    },
  };
}
