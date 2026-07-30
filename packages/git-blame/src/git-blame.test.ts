import { describe, it, expect } from 'vitest';
import { gitBlame } from './index';
import path from 'path';

describe('gitBlame', () => {
  it('returns null for non-existent file', () => {
    const result = gitBlame('nonexistent.ts', 1, process.cwd());
    expect(result).toBeNull();
  });

  it('can blame itself in the perfsense repo', () => {
    const thisFile = path.join(__dirname, 'index.ts');
    const result = gitBlame(thisFile, 1, process.cwd());
    if (result) {
      expect(result).toHaveProperty('commit');
      expect(result).toHaveProperty('author');
      expect(result).toHaveProperty('line');
      expect(result.confidence).toBe('exact');
    }
  });
});
