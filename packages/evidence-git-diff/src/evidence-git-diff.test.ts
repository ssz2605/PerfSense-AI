import { describe, it, expect } from 'vitest';
import { scanPerfSensitiveChanges } from './index';

describe('scanPerfSensitiveChanges', () => {
  it('detects a widened setTimeout delay as increased on the changed file', () => {
    const patch = [
      'diff --git a/js/SaveInterface.js b/js/SaveInterface.js',
      'index abc..def 100644',
      '--- a/js/SaveInterface.js',
      '+++ b/js/SaveInterface.js',
      '@@ -40,3 +40,3 @@ export async function saveMIDI() {',
      '-  setTimeout(exportMIDITime, 500);',
      '+  setTimeout(exportMIDITime, 2500);',
      ' }',
    ].join('\n');

    const findings = scanPerfSensitiveChanges(patch);
    const scheduling = findings.find((f) => f.direction === 'increased');
    expect(scheduling).toBeDefined();
    expect(scheduling!.file).toBe('js/SaveInterface.js');
    expect(scheduling!.description).toContain('500ms → 2500ms');
    // The added setTimeout line sits at new-file position 40.
    expect(scheduling!.line).toBe(40);
  });

  it('reports added scheduling/deferral when only an added delay exists', () => {
    const patch = [
      'diff --git a/js/SaveInterface.js b/js/SaveInterface.js',
      'index abc..def 100644',
      '--- a/js/SaveInterface.js',
      '+++ b/js/SaveInterface.js',
      '@@ -20,2 +20,3 @@ export async function saveMIDI() {',
      '   void doWork();',
      '+  await new Promise((resolve) => setTimeout(resolve, 2000));',
      ' }',
    ].join('\n');

    const findings = scanPerfSensitiveChanges(patch);
    const added = findings.find((f) => f.description.includes('Added scheduling'));
    expect(added).toBeDefined();
    expect(added!.direction).toBe('added');
  });

  it('detects added async deferral and loop work generically', () => {
    const patch = [
      'diff --git a/js/loader.js b/js/loader.js',
      'index abc..def 100644',
      '--- a/js/loader.js',
      '+++ b/js/loader.js',
      '@@ -10,2 +10,4 @@ export function loadProject() {',
      '   const data = read();',
      '+  for (const block of data.blocks) {',
      '+    await hydrate(block);',
      '+  }',
      ' }',
    ].join('\n');

    const findings = scanPerfSensitiveChanges(patch);
    expect(findings.some((f) => f.description.includes('Added repeated work'))).toBe(true);
    const deferral = findings.find((f) => f.description.includes('Added deferral/async boundary'));
    expect(deferral).toBeDefined();
    expect(deferral!.file).toBe('js/loader.js');
    expect(deferral!.line).toBe(12);
  });

  it('captures the enclosing function context from the diff hunk header', () => {
    const patch = [
      'diff --git a/js/SaveInterface.js b/js/SaveInterface.js',
      'index abc..def 100644',
      '--- a/js/SaveInterface.js',
      '+++ b/js/SaveInterface.js',
      '@@ -40,3 +40,3 @@ export function afterSaveMIDI() {',
      '-  setTimeout(exportMIDITime, 500);',
      '+  setTimeout(exportMIDITime, 2500);',
      ' }',
    ].join('\n');

    const findings = scanPerfSensitiveChanges(patch);
    const scheduling = findings.find((f) => f.direction === 'increased');
    expect(scheduling).toBeDefined();
    expect(scheduling!.function).toBe('export function afterSaveMIDI() {');
  });

  it('leaves function context empty when the hunk header has no trailer', () => {
    const patch = [
      'diff --git a/js/SaveInterface.js b/js/SaveInterface.js',
      'index abc..def 100644',
      '--- a/js/SaveInterface.js',
      '+++ b/js/SaveInterface.js',
      '@@ -40,3 +40,3 @@',
      '-  setTimeout(exportMIDITime, 500);',
      '+  setTimeout(exportMIDITime, 2500);',
      ' }',
    ].join('\n');

    const findings = scanPerfSensitiveChanges(patch);
    const scheduling = findings.find((f) => f.direction === 'increased');
    expect(scheduling).toBeDefined();
    expect(scheduling!.function).toBeUndefined();
  });

  it('does not claim a class declaration as a function', () => {
    // Mirrors the real mock-pr-f diff: git's hunk header trailer is the class
    // declaration (`class SaveInterface {`), which is NOT a function name.
    const patch = [
      'diff --git a/js/SaveInterface.js b/js/SaveInterface.js',
      'index abc..def 100644',
      '--- a/js/SaveInterface.js',
      '+++ b/js/SaveInterface.js',
      '@@ -502,7 +502,7 @@ class SaveInterface {',
      '             generateMidi(data);',
      '             this.activity.logo._midiData = {};',
      '             document.body.style.cursor = "default";',
      '-        }, 500);',
      '+        }, 2500);',
      '     }',
      '',
      '     /**',
    ].join('\n');

    const findings = scanPerfSensitiveChanges(patch);
    const scheduling = findings.find((f) => f.direction === 'increased');
    expect(scheduling).toBeDefined();
    expect(scheduling!.description).toContain('Scheduling delay increased (500ms → 2500ms)');
    expect(scheduling!.line).toBe(505);
    expect(scheduling!.function).toBeUndefined();
  });

  it('returns no findings for a patch with only benign changes', () => {
    const patch = [
      'diff --git a/js/utils/utils.js b/js/utils/utils.js',
      'index abc..def 100644',
      '--- a/js/utils/utils.js',
      '+++ b/js/utils/utils.js',
      '@@ -5,1 +5,1 @@ export function help() {',
      '-  const a = 1;',
      '+  const a = 2;',
      ' }',
    ].join('\n');

    expect(scanPerfSensitiveChanges(patch)).toEqual([]);
  });
});