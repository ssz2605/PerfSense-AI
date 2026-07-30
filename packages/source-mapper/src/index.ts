import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';

export interface SourceLocation {
  originalFile: string;
  originalLine: number;
  originalColumn: number;
  minifiedFile: string;
  minifiedLine: number;
  confidence: 'exact' | 'approximate' | 'unavailable';
}

export function resolveSourceLocation(
  minifiedFile: string,
  minifiedLine: number,
  sourceMapDir: string,
): SourceLocation | null {
  try {
    const mapPath = findSourceMap(minifiedFile, sourceMapDir);
    if (!mapPath) {
      return null;
    }
    const fs = require('fs');
    const mapContent = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
    const tracer = new TraceMap(mapContent);
    const original = originalPositionFor(tracer, { line: minifiedLine, column: 0 });
    if (!original || !original.source) {
      return {
        originalFile: minifiedFile,
        originalLine: minifiedLine,
        originalColumn: 0,
        minifiedFile,
        minifiedLine,
        confidence: 'unavailable',
      };
    }
    return {
      originalFile: original.source,
      originalLine: original.line ?? minifiedLine,
      originalColumn: original.column ?? 0,
      minifiedFile,
      minifiedLine,
      confidence: original.line !== null ? 'exact' : 'approximate',
    };
  } catch {
    return null;
  }
}

export function resolveTraceLocation(
  traceSummary: string,
  sourceMapDir: string,
): SourceLocation | null {
  const match = traceSummary.match(/([\w\-./]+\.\w+):(\d+)/);
  if (!match) return null;
  const file = match[1];
  const line = parseInt(match[2], 10);
  return resolveSourceLocation(file, line, sourceMapDir);
}

function findSourceMap(minifiedFile: string, sourceMapDir: string): string | null {
  const fs = require('fs');
  const path = require('path');
  const baseName = path.basename(minifiedFile);
  const candidates = [
    path.join(sourceMapDir, `${baseName}.map`),
    path.join(sourceMapDir, baseName.replace(/\.\w+$/, '') + '.js.map'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
