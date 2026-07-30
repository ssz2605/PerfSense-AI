# PerfSense

A performance regression detection framework with evidence collection, correlation engine, GitHub Action integration, and AI-powered analysis.

## Quick Start

```bash
# 1. Clone and install
git clone <repo>
cd perfsense
pnpm install
pnpm build

# 2. Benchmark a page
cd examples/music-blocks
npx perfsense benchmark --config perfsense.config.json --out results.json

# 3. Save baseline
npx perfsense baseline save --from results.json --out baseline.json

# 4. Check for regressions
npx perfsense check --baseline baseline.json --current results.json --statistical --format json
```

## GitHub Action Setup

Add `.github/workflows/perfsense.yml` to your repository:

```yaml
name: Performance
on:
  pull_request:
    paths:
      - '**.js'
      - '**.ts'
      - '**.tsx'
      - '**.css'
jobs:
  perf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Run PerfSense
        uses: your-org/perfsense/github-action@v1
        with:
          api-key: ${{ secrets.OPENAI_API_KEY }}
          fail-on-regression: 'true'
          config: './perfsense.config.json'
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   perfsense CLI                       │
│  benchmark ──── baseline ──── check ──── report     │
│                   └── cache                          │
└─────────────────────────────────────────────────────┘
         │                 │                 │
         ▼                 ▼                 ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
│  Playwright   │ │  Statistics  │ │  Correlation     │
│  Driver       │ │  Engine      │ │  Engine          │
├──────────────┤ ├──────────────┤ ├──────────────────┤
│ metrics-core  │ │ median       │ │ group evidence   │
│ musicblocks   │ │ percentile   │ │ rank by priority │
│ evidence-*    │ │ Mann-Whitney │ │ assign confidence│
│               │ │ Cliff's delta│ │ extract cause    │
└──────────────┘ └──────────────┘ └──────────────────┘
                                           │
          ┌────────────────────────────────┼──────────────┐
          ▼                                ▼              ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Source Mapper    │ │  Git Blame       │ │  AI Provider     │
│  bundle.js:142    │ │  Stage.ts:142    │ │  OpenAI/Anthropic│
│  → Stage.ts:142   │ │  → a1b2c3d      │ │  → explanation   │
└──────────────────┘ └──────────────────┘ └──────────────────┘
          │                                │
          └──────────┬─────────────────────┘
                     ▼
          ┌──────────────────┐
          │  Reporter GitHub  │
          │  → PR comment     │
          └──────────────────┘
```

### Package Overview

| Package | Description |
|---------|-------------|
| `@perfsense/core` | Shared types: Evidence, MetricMeta, BaselineData |
| `@perfsense/statistics` | Statistical functions: median, Mann-Whitney U, Cliff's delta, regression classification |
| `@perfsense/metrics-core` | Standard web metrics: TTFB, FCP, LCP |
| `@perfsense/metrics-musicblocks` | Music Blocks custom metrics: playbackLatency, audioDrift, stageUpdateTime, blockThroughput, projectLoadTime |
| `@perfsense/driver-playwright` | Playwright-based benchmark driver with evidence collection |
| `@perfsense/evidence-trace` | Chrome trace evidence (Performance API + tracing) |
| `@perfsense/evidence-network` | Network waterfall evidence (request/response capture) |
| `@perfsense/evidence-git-diff` | Git diff evidence (changed files, bundle-affecting changes) |
| `@perfsense/correlation-engine` | Pure-function correlation: groups evidence, ranks by confidence, assigns tiers, extracts likely causes, deduplicates across metrics |
| `@perfsense/source-mapper` | Resolves minified trace locations to original source via source maps |
| `@perfsense/git-blame` | Runs git blame on source files to find commit + author |
| `@perfsense/ai-provider` | Abstraction over OpenAI, Anthropic, Ollama for AI analysis |
| `@perfsense/reporter-github` | Generates PR comment markdown with regression table, evidence, and AI |
| `@perfsense/github-action` | GitHub Action wrapper — installs, benchmarks, checks, posts PR comment |
| `@perfsense/cli` | CLI entry point: benchmark, baseline, check, report, cache commands |

## Adding Custom Metrics

Create a plugin implementing `MetricPlugin`:

```typescript
import type { MetricPlugin } from '@perfsense/core';
import type { Page } from 'playwright';

export class MyMetric implements MetricPlugin {
  name = 'myMetric';
  setupPostNav?: (page: Page) => Promise<void>;

  async setupPage(page: Page): Promise<void> {
    // Optional: setup before navigation
  }

  async extractMetric(page: Page): Promise<number | null> {
    return await page.evaluate(() => performance.now());
  }
}
```

Register it in your config's `metrics` array.

## Example PR Comment Output

```
## PerfSense AI - Performance Report

### Summary
| Metric | Baseline | Current | Delta | Status |
|--------|----------|---------|-------|--------|
| LCP | 1850.0ms | 2134.0ms | +15.3% | :x: |
| FCP | 420.0ms | 428.0ms | +1.9% | :white_check_mark: |
| playbackLatency | 2.8ms | 38.9ms | +1289.0% | :x: |

### :x: LCP: +15.3%
**Likely cause:** Main thread blocked 312ms by layout recalculation
- **Source:** `src/components/Stage.ts:142`
- **Commit:** `a1b2c3d` by @shrey - "Add animated block transitions"
- **Evidence:** Chrome trace (312ms long task)

### :x: playbackLatency: +1289%
**Likely cause:** AudioContext.createBuffer blocked 42ms
- **Source:** `src/audio/engine.ts:87`
- **Commit:** `d4e5f6g` by @shrey - "Refactor audio buffer allocation"
- **Evidence:** Chrome trace (42ms long task)

<details>
<summary>AI Analysis</summary>
The LCP regression appears to be caused by commit a1b2c3d which added a layout recalculation. Consider moving this to requestAnimationFrame.
</details>

<details>
<summary>Artifacts</summary>
- [Full results JSON](./perfsense-results.json)
</details>
```

## CLI Commands

```bash
# Benchmark
perfsense benchmark --pages <files> --runs <n> [--config <config>] [--out <file>]

# Baseline management
perfsense baseline save --from <results.json> --out <baseline.json>
perfsense baseline load --file <baseline.json>

# Check for regressions
perfsense check --baseline <baseline.json> --current <results.json> [--statistical] [--format json] [--no-evidence]

# Full report with source blame and AI
perfsense report --baseline <baseline.json> --current <results.json> [--repository <dir>] [--source-maps <dir>] [--ai-provider openai] [--ai-model gpt-4o-mini]

# Cache check
perfsense cache --changed-files "file1,file2,..."
```

## Caching

Benchmarks are automatically skipped when only non-bundle files change:

| Changed files | Result |
|---------------|--------|
| `README.md`, `CONTRIBUTING.md` | Skipped — no performance-relevant changes |
| `src/index.ts`, `src/style.css` | Runs benchmark |
| `package.json` | Skipped |

## AI Analysis

PerfSense supports three AI providers:

| Provider | Default Model | API Key Required |
|----------|--------------|-----------------|
| OpenAI | gpt-4o-mini | Yes |
| Anthropic | claude-3-haiku | Yes |
| Ollama | llama3 | No (local) |

If no API key is provided, AI is skipped entirely — output contains evidence + correlation only.

## Development

```bash
pnpm install
pnpm build
pnpm lint
pnpm test
pnpm test -- --run e2e-tests/github-action.test.ts  # E2E tests (requires Playwright)
```

### Project Structure

```
perfsense/
├── packages/
│   ├── core/                    # Shared types
│   ├── statistics/              # Statistical engine
│   ├── metrics-core/            # TTFB, FCP, LCP
│   ├── metrics-musicblocks/     # Music Blocks plugins
│   ├── driver-playwright/       # Benchmark driver + evidence collector
│   ├── evidence-trace/          # Chrome trace evidence
│   ├── evidence-network/        # Network evidence
│   ├── evidence-git-diff/       # Git diff evidence
│   ├── correlation-engine/      # Correlation + source blame integration
│   ├── source-mapper/           # Source map resolution
│   ├── git-blame/               # Git blame integration
│   ├── ai-provider/             # OpenAI/Anthropic/Ollama
│   │   └── src/prompts/         # Prompt templates
│   ├── reporter-github/         # PR comment markdown generator
│   ├── github-action/           # GitHub Action wrapper
│   └── cli/                     # CLI entry point
├── e2e-tests/                   # End-to-end tests
└── examples/
    ├── benchmark-pages/         # Standard benchmark pages
    └── music-blocks/            # Music Blocks mock pages
```
