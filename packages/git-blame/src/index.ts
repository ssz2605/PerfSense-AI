import { execSync } from 'child_process';
import path from 'path';

export interface BlameResult {
  commit: string;
  author: string;
  email: string;
  date: string;
  message: string;
  line: number;
  confidence: 'exact' | 'approximate' | 'unavailable';
}

export function gitBlame(
  filePath: string,
  lineNumber: number,
  repoDir?: string,
): BlameResult | null {
  const cwd = repoDir || process.cwd();
  try {
    const porcelain = execSync(
      `git blame -L ${lineNumber},${lineNumber} --porcelain "${filePath}"`,
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return parsePorcelain(porcelain, lineNumber);
  } catch {
    return null;
  }
}

function parsePorcelain(output: string, lineNumber: number): BlameResult | null {
  const lines = output.split('\n');
  if (lines.length < 2) return null;
  const header = lines[0].split(' ');
  const commit = header[0];
  if (commit === '0000000000000000000000000000000000000000') {
    return null;
  }
  const result: BlameResult = {
    commit,
    author: '',
    email: '',
    date: '',
    message: '',
    line: lineNumber,
    confidence: 'exact',
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('author ')) {
      result.author = line.slice(7);
    } else if (line.startsWith('author-mail ')) {
      result.email = line.slice(12).replace(/[<>]/g, '');
    } else if (line.startsWith('author-time ')) {
      const ts = parseInt(line.slice(11), 10);
      result.date = new Date(ts * 1000).toISOString();
    } else if (line.startsWith('\t')) {
      result.message = line.slice(1);
    }
  }
  return result;
}
