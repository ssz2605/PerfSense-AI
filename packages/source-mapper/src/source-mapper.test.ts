import { describe, it, expect } from 'vitest';
import { resolveSourceLocation, resolveTraceLocation } from './index';
import path from 'path';
import fs from 'fs';
import os from 'os';

function createTempSourceMap(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
  const mapContent = {
    version: 3,
    file: 'bundle.js',
    sources: ['src/components/Stage.ts'],
    names: [],
    mappings: ';AAAA;AACA;AACA;AACA;AACA',
    lineCount: 10,
  };
  fs.writeFileSync(path.join(dir, 'bundle.js.map'), JSON.stringify(mapContent));
  return dir;
}

describe('resolveSourceLocation', () => {
  it('returns null when source map does not exist', () => {
    const result = resolveSourceLocation('nonexistent.js', 1, '/tmp');
    expect(result).toBeNull();
  });

  it('resolves location when source map exists', () => {
    const dir = createTempSourceMap();
    try {
      const result = resolveSourceLocation('bundle.js', 2, dir);
      expect(result).not.toBeNull();
      expect(result!.minifiedFile).toBe('bundle.js');
      expect(result!.minifiedLine).toBe(2);
      expect(result!.confidence).toBe('exact');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveTraceLocation', () => {
  it('parses file:line from trace summary with source map', () => {
    const dir = createTempSourceMap();
    try {
      const result = resolveTraceLocation('bundle.js:142', dir);
      expect(result).not.toBeNull();
      expect(result!.minifiedFile).toBe('bundle.js');
      expect(result!.minifiedLine).toBe(142);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for invalid trace format', () => {
    const result = resolveTraceLocation('no-valid-location', '/tmp');
    expect(result).toBeNull();
  });
});
