import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  openProjectGateSnippet,
  withOpenProjectGuard,
  resolveRunTimeout,
} from './driver';

/**
 * Two harness defects made the benchmark report numbers that described a page
 * which was not the one under test. Both produced plausible-looking results, so
 * nothing downstream could have caught them.
 */

/** Compile the gate snippet against a stubbed `window`, the way scenarios.test.ts does. */
function makeGate(win: Record<string, any>) {
  // Wrapped in parentheses: the snippet opens with a newline, and a bare
  // `return` before a line terminator would parse as `return;`.
  const factory = new Function('window', `return (${openProjectGateSnippet});`);
  return (timeoutMs: number) => factory(win)(timeoutMs) as Promise<{
    ready: boolean;
    isMock: boolean;
  }>;
}

/** The mock bridge: `ui` present, no `blocks` -- it fakes the workspace with DOM. */
function mockWindow() {
  return {
    __mb: { ui: { save: () => Promise.resolve() } },
    __mbPerf: { measures: { bootstrapStart: 12, initTotal: 583 } },
  };
}

/** The real bridge: `ui` and `blocks` together, plus the perfMarks seam. */
function realWindow() {
  return {
    __mb: { ui: {}, blocks: { blockList: {}, projectLoaded: () => true } },
    __mbPerf: { measures: { bootstrapStart: 12, initTotal: 583 } },
  };
}

describe('openProjectGateSnippet mock detection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not call a real app a mock just because ui exists', async () => {
    // The regression: `isMock` tested `__mb.ui` alone, so every real app page
    // was classified as a mock. The caller reads that flag to decide whether to
    // verify perfMarks.openStart, so the phantom-load guard was switched off on
    // exactly the pages it exists for.
    const gate = makeGate(realWindow());
    const settled = gate(120000);
    let result: { ready: boolean; isMock: boolean } | null = null;
    void settled.then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(result).toEqual({ ready: true, isMock: false });
  });

  it('still accepts the static mock on its boot measures alone', async () => {
    // A mock has no `blocks` by construction, so it must keep the
    // `bridged || booted` shortcut that lets it proceed immediately; otherwise
    // every mock-based e2e run would sit out the full 120s gate.
    const gate = makeGate(mockWindow());
    const settled = gate(120000);
    let result: { ready: boolean; isMock: boolean } | null = null;
    void settled.then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(result).toEqual({ ready: true, isMock: true });
  });
});

describe('withOpenProjectGuard', () => {
  it('lets a guard failure out instead of warning past it', async () => {
    // Regression: the phantom-load `throw` was caught by the surrounding
    // try/catch, logged as "no file input", and the run continued against a
    // workspace that was never opened -- which is how a phantom load becomes a
    // baseline that looks fine.
    const warnings: string[] = [];
    await expect(
      withOpenProjectGuard(
        async (fail) => {
          fail();
          throw new Error('fixture never opened');
        },
        (m) => warnings.push(m),
      ),
    ).rejects.toThrow('fixture never opened');
    expect(warnings).toEqual([]);
  });

  it('warns and continues when the file input is simply missing', async () => {
    // Not fatal: the run still measures whatever the page shows, which is worth
    // a warning rather than a dead capture.
    const warnings: string[] = [];
    await withOpenProjectGuard(
      async () => {
        throw new Error('no file input on page');
      },
      (m) => warnings.push(m),
    );
    expect(warnings).toEqual(['no file input on page']);
  });

  it('passes a clean drop through untouched', async () => {
    const warnings: string[] = [];
    let ran = false;
    await withOpenProjectGuard(
      async () => {
        ran = true;
      },
      (m) => warnings.push(m),
    );
    expect(ran).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe('resolveRunTimeout', () => {
  it('prefers the page-specific budget over the global one', () => {
    // The reason `runTimeouts` exists at all: musical-tree measures ~289s of
    // scenario work against a 300s global budget, so its runs were being
    // discarded as timeouts rather than measured.
    expect(
      resolveRunTimeout(
        { runTimeoutMs: 300000, runTimeouts: { 'musical-tree.html': 420000 } },
        'musical-tree.html',
      ),
    ).toBe(420000);
  });

  it('leaves the global budget in charge for every page it does not name', () => {
    // A per-page raise must not become a raise for everything: that would hand
    // the slack to the fast fixtures, where it could only mask a real hang.
    const config = {
      runTimeoutMs: 300000,
      runTimeouts: { 'musical-tree.html': 420000 },
    };
    expect(resolveRunTimeout(config, 'Frere-Jacques.html')).toBe(300000);
    expect(resolveRunTimeout(config, 'index.html')).toBe(300000);
  });

  it('falls back to the built-in default when neither is set', () => {
    expect(resolveRunTimeout({}, 'index.html')).toBe(120000);
  });

  it('honours a per-page budget even with no global one', () => {
    // The override must not depend on runTimeoutMs being present, or a config
    // that only sets runTimeouts would silently time every page out at 120s.
    expect(
      resolveRunTimeout({ runTimeouts: { 'musical-tree.html': 420000 } }, 'musical-tree.html'),
    ).toBe(420000);
  });
});