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
  perfSensitive: PerfSensitiveChange[];
}

/**
 * A generic, performance-relevant code change detected in the diff patch.
 * `direction` mirrors how the change moves the measured operation: added or
 * increased work/deferral (slower), removed/decreased work (faster), or
 * unknown when the patch does not make the effect obvious.
 */
interface PerfSensitiveChange {
  file: string;
  line: number;
  description: string;
  direction: 'increased' | 'decreased' | 'added' | 'removed' | 'unknown';
  /** Enclosing function context from the diff hunk trailer, when git provides it. */
  function?: string;
}

/** True when an added/removed diff line matches one of the generic perf patterns. */
const PERF_SIGNALS: Array<{
  direction: PerfSensitiveChange['direction'];
  description: string;
  matches: (line: string) => boolean;
}> = [
  {
    direction: 'added',
    description: 'Added deferral/async boundary (await/Promise)',
    matches: (line) => /\bawait\b|\.then\s*\(|new Promise\(|queueMicrotask\(|setImmediate\(/.test(line),
  },
  {
    direction: 'added',
    description: 'Added repeated work (loop/iteration)',
    matches: (line) => /\bfor\s*\(|\bwhile\s*\(|\.forEach\(|\.map\(|\.reduce\(/.test(line),
  },
  {
    direction: 'added',
    description: 'Added DOM work',
    matches: (line) => /document\.createElement|appendChild|insertBefore|innerHTML\s*=/.test(line),
  },
  {
    direction: 'added',
    description: 'Added storage/network/file operation',
    matches: (line) =>
      /\blocalStorage\.|indexedDB\.|fetch\s*\(|XMLHttpRequest|readFileSync|writeFileSync|\.readFile\(|\.writeFile\(/.test(line),
  },
  {
    direction: 'added',
    description: 'Added audio scheduling work',
    matches: (line) => /AudioContext|createOscillator|scheduleAtTime|\.start\s*\(\s*[^)]*delay|scheduler\./.test(line),
  },
  {
    direction: 'added',
    description: 'Added debounce/throttle or retry/polling delay',
    matches: (line) => /debounce\s*\(|throttle\s*\(|setInterval\s*\(|retry\s*\(|poll\s*\(/.test(line),
  },
  {
    direction: 'removed',
    description: 'Removed caching/memoization',
    matches: (line) => /\bcache\b|memoiz|\.cached\b|localStorage\.getItem\(\s*['"][^'"]*cache/.test(line),
  },
  {
    direction: 'added',
    description: 'Added allocation-heavy operation',
    matches: (line) => /new (Array|Set|Map)\(|\.push\s*\(|\.slice\s*\(|\.concat\s*\(|JSON\.(stringify|parse)\s*\(/.test(line),
  },
];

function parseSchedulingDelay(line: string): number | null {
  const match = line.match(/\bset(?:Timeout|Interval|Immediate)\s*\(\s*[^,)]+,\s*(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Detect a callback-call tail whose delay literal changed even when the timer
 * keyword sits outside the diff hunk: "}, 500);" → "}, 2500);" is the closing
 * of `setTimeout(() => { ... }, delay)`. The `} , <number> );` shape is a
 * two-argument call whose second argument is a numeric delay, so widening it
 * is a scheduling-delay increase.
 */
function parseTailDelay(line: string): number | null {
  const match = line.match(/^\s*}\s*,\s*(\d+)\s*\)\s*;?$/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Scan a unified diff patch for generic perf-sensitive changes. Groups added
 * and removed lines per file, and compares scheduling-delay literals so a
 * widened setTimeout is reported as `increased` rather than a bare keyword hit.
 */
/**
 * True when a diff hunk trailer plausibly names a function/method rather than
 * another code construct (e.g. a `class X {` header). git appends the nearest
 * enclosing scope to the `@@ ... @@` header; class declarations are valid
 * context but are not function names, so they are dropped to keep the
 * "Function:" field honest.
 */
function looksLikeFunction(context: string): boolean {
  const trimmed = context.trim();
  if (/\bfunction\b/.test(trimmed)) return true;
  if (/=>/.test(trimmed)) return true;
  // Method signature: name(params) [ : ret ] [ { ]
  return /^[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{?$/.test(trimmed);
}

export function scanPerfSensitiveChanges(patch: string): PerfSensitiveChange[] {
  const findings: PerfSensitiveChange[] = [];
  const lines = patch.split('\n');

  let currentFile = '';
  let inHunk = false;
  let newLine = 0;
  let currentFunction = '';
  const addedLines: Array<{ text: string; line: number }> = [];
  const removedLines: string[] = [];

  const flushFile = () => {
    if (!currentFile || (addedLines.length === 0 && removedLines.length === 0)) return;
    const addedDelays = addedLines.map((a) => parseSchedulingDelay(a.text)).filter((n): n is number => n !== null);
    const removedDelays = removedLines.map(parseSchedulingDelay).filter((n): n is number => n !== null);
    const maxAddedDelay = addedDelays.length > 0 ? Math.max(...addedDelays) : null;
    const maxRemovedDelay = removedDelays.length > 0 ? Math.max(...removedDelays) : null;
    const addedDelayLine = (delay: number): number => {
      const idx = addedLines.findIndex((a) => parseSchedulingDelay(a.text) === delay);
      return idx >= 0 ? addedLines[idx].line : addedLines.length > 0 ? addedLines[addedLines.length - 1].line : 0;
    };
    const make = (line: number, description: string, direction: PerfSensitiveChange['direction']): PerfSensitiveChange => ({
      file: currentFile,
      line,
      description,
      direction,
      function: currentFunction || undefined,
    });
    if (maxAddedDelay !== null && maxRemovedDelay !== null && maxAddedDelay > maxRemovedDelay) {
      findings.push(make(addedDelayLine(maxAddedDelay), `Scheduling delay increased (${maxRemovedDelay}ms → ${maxAddedDelay}ms) via setTimeout/setInterval`, 'increased'));
    } else if (maxAddedDelay !== null && maxRemovedDelay === null) {
      findings.push(make(addedDelayLine(maxAddedDelay), `Added scheduling/deferral (setTimeout/setInterval ${maxAddedDelay}ms)`, 'added'));
    } else if (maxAddedDelay !== null && maxRemovedDelay !== null && maxAddedDelay < maxRemovedDelay) {
      findings.push(make(addedDelayLine(maxAddedDelay), `Scheduling delay decreased (${maxAddedDelay}ms → ${maxRemovedDelay}ms)`, 'decreased'));
    } else {
      // No timer keyword visible in the hunk — the delay change may be on a
      // callback tail whose opening is outside the diff ("}, 500);" → "}, 2500);").
      const addedTails = addedLines
        .map((a) => ({ text: a.text, line: a.line, delay: parseTailDelay(a.text) }))
        .filter((x): x is { text: string; line: number; delay: number } => x.delay !== null);
      const removedTailDelays = removedLines.map(parseTailDelay).filter((n): n is number => n !== null);
      const maxTailAdded = addedTails.length > 0 ? Math.max(...addedTails.map((x) => x.delay)) : null;
      const maxTailRemoved = removedTailDelays.length > 0 ? Math.max(...removedTailDelays) : null;
      if (maxTailAdded !== null && maxTailRemoved !== null && maxTailAdded > maxTailRemoved) {
        const tailLine = addedTails.find((x) => x.delay === maxTailAdded)?.line ?? addedTails[addedTails.length - 1].line;
        findings.push(make(tailLine, `Scheduling delay increased (${maxTailRemoved}ms → ${maxTailAdded}ms)`, 'increased'));
      } else if (maxTailAdded !== null && maxTailRemoved === null) {
        const tailLine = addedTails.find((x) => x.delay === maxTailAdded)?.line ?? addedTails[addedTails.length - 1].line;
        findings.push(make(tailLine, `Added scheduling/deferral (${maxTailAdded}ms)`, 'added'));
      } else if (maxTailAdded !== null && maxTailRemoved !== null && maxTailAdded < maxTailRemoved) {
        const tailLine = addedTails.find((x) => x.delay === maxTailAdded)?.line ?? addedTails[addedTails.length - 1].line;
        findings.push(make(tailLine, `Scheduling delay decreased (${maxTailAdded}ms → ${maxTailRemoved}ms)`, 'decreased'));
      }
    }
    for (const added of addedLines) {
      for (const signal of PERF_SIGNALS) {
        if (signal.matches(added.text)) {
          findings.push(make(added.line, signal.description, signal.direction));
          break;
        }
      }
    }
  };

  for (const rawLine of lines) {
    if (rawLine === '\\ No newline at end of file') continue;
    if (rawLine.startsWith('diff --git ')) {
      flushFile();
      addedLines.length = 0;
      removedLines.length = 0;
      inHunk = false;
      newLine = 0;
      currentFunction = '';
      const match = rawLine.match(/diff --git a\/\S+ b\/(\S+)/);
      currentFile = match ? match[1].replace(/^b\//, '') : '';
      continue;
    }
    if (!currentFile) continue;
    if (rawLine.startsWith('+++ ') || rawLine.startsWith('--- ') || rawLine.startsWith('index ') || rawLine.startsWith('new file') || rawLine.startsWith('deleted file')) {
      continue;
    }
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s+(.*))?$/);
    if (hunkMatch) {
      inHunk = true;
      newLine = parseInt(hunkMatch[1], 10);
      // git appends the enclosing function context to the hunk header; keep it
      // as the function-context for perf findings in this hunk — but only when
      // it actually names a function/method (class declarations are not).
      const trailer = (hunkMatch[2] ?? '').trim();
      currentFunction = looksLikeFunction(trailer) ? trailer : '';
      continue;
    }
    if (!inHunk || rawLine.startsWith('@@')) continue;
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      addedLines.push({ text: rawLine.slice(1), line: newLine });
      newLine += 1;
    } else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      removedLines.push(rawLine.slice(1));
    } else {
      newLine += 1;
    }
  }
  flushFile();

  return findings;
}

function runGitDiff(cwd: string): DiffResult | null {
  try {
    const numstatOut = execSync('git diff HEAD~1 --numstat', { cwd, encoding: 'utf-8', timeout: 5000 });
    const patchOut = execSync('git diff HEAD~1 --unified=3', { cwd, encoding: 'utf-8', timeout: 8000 });

    const perfSensitive = scanPerfSensitiveChanges(patchOut);

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
      perfSensitive,
    };
  } catch {
    return null;
  }
}

export function collectGitDiffEvidence(metricName: string, repoDir?: string): Evidence {
  const startTime = Date.now();
  const cwd = repoDir || process.cwd();
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

  for (const perf of result.perfSensitive) {
    highlights.push({
      label: 'Perf-sensitive change',
      value: `${perf.file}:${perf.line}: ${perf.description} (${perf.direction})`,
      severity: 'warning',
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
  if (result.perfSensitive.length > 0) {
    summary += `, ${result.perfSensitive.length} perf-sensitive change(s)`;
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
      perfSensitive: result.perfSensitive.slice(0, 10),
    },
  };
}
