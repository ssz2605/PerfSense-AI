# PerfSense

A performance regression detection framework that compares benchmark results against baselines, collects supporting evidence, and optionally provides AI-assisted analysis.

## What It Does

PerfSense answers a simple question:

> **Did this change make the application slower?**

It runs the same benchmark multiple times, compares current results against a stored baseline, and reports meaningful performance changes.

For example:

| Metric | Baseline | Current | Change |
|---|---:|---:|---:|
| Load Time | 19.2s | 25.1s | +30.7% |
| FCP | 420ms | 428ms | +1.9% |
| Render Time | 3.2ms | 4.1ms | +28.1% |

PerfSense is **warn-only by default**. It reports regressions without blocking pull requests.

Projects can optionally enable enforcement with `fail-on-regression: 'true'` if they want performance regressions to fail the GitHub check.

---

## Quick Start

```bash
# 1. Clone and install
git clone <repository-url>
cd perfsense
pnpm install
pnpm build

# 2. Benchmark a page
npx perfsense benchmark \
  --pages <page-or-pages> \
  --runs 5 \
  --out results.json

# 3. Save a baseline
npx perfsense baseline save \
  --from results.json \
  --out baseline.json

# 4. Compare current results against the baseline
npx perfsense check \
  --baseline baseline.json \
  --current results.json \
  --statistical \
  --format json
```

---

## How It Works

```text
              Application / PR
                    │
                    ▼
             Playwright Driver
                    │
                    ▼
              Run benchmarks
                    │
                    ▼
             Collect metrics
                    │
          ┌─────────┴─────────┐
          │                   │
       Baseline            Current
          │                   │
          └─────────┬─────────┘
                    ▼
           Statistical Analysis
                    │
                    ▼
            Regression Detection
                    │
                    ▼
          Evidence + Correlation
                    │
              ┌─────┴─────┐
              │           │
           Optional      Git
              AI        Evidence
              │           │
              └─────┬─────┘
                    ▼
              PR Report
```

---

## GitHub Action

PerfSense can run automatically on pull requests.

Add a workflow such as:

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
          config: './perfsense.config.json'
          fail-on-regression: 'false'
```

Replace `your-org/perfsense` with the published GitHub Action repository.

### Warn-Only by Default

PerfSense does **not** block pull requests by default.

When a regression is detected, the GitHub Action reports it in the PR without failing the check.

If a project wants enforcement, it can explicitly enable it:

```yaml
- name: Run PerfSense
  uses: your-org/perfsense/github-action@v1
  with:
    config: './perfsense.config.json'
    fail-on-regression: 'true'
```

This allows teams to start with performance visibility before introducing performance gates.

---

## Statistical Comparison

Browser benchmarks naturally contain noise, so PerfSense does not rely on a single run or a raw average.

It supports:

- Median and percentile measurements
- **Mann-Whitney U** statistical testing
- **Cliff's delta** effect size
- Regression classification

Multiple benchmark runs are compared as distributions rather than relying on a single measurement.

This helps distinguish normal benchmark variation from meaningful performance changes.

---

## Evidence Collection

When a regression is detected, PerfSense can collect supporting evidence:

- Chrome performance traces
- Performance API measurements
- Network waterfalls
- Git diffs
- Changed files
- Source-map locations
- Git blame information

The goal is to move from:

> "The application became slower."

to:

> "This metric increased by 30%, and the change overlaps with code modified in this PR."

PerfSense provides evidence for investigation rather than claiming that correlation automatically proves causation.

---

## Correlation Engine

The correlation engine combines performance results with collected evidence.

It can:

- group related evidence
- rank potential causes
- assign confidence levels
- associate metrics with changed files
- deduplicate overlapping evidence

Example:

```text
Load Time Regression
        │
        ▼
Chrome Trace
        │
        ▼
Long Task
        │
        ▼
Source Map
        │
        ▼
src/components/Stage.ts:142
        │
        ▼
Git Diff / Blame
        │
        ▼
Potentially related change
```

---

## Optional AI Analysis

AI is an **optional final analysis layer**.

The pipeline is:

```text
Metrics
   ↓
Statistics
   ↓
Regression Detection
   ↓
Evidence
   ↓
Correlation
   ↓
Optional AI
   ↓
Report
```

AI does not decide whether a regression occurred.

Instead, it uses the already-collected results and evidence to produce a concise explanation.

For example:

> "Load time increased by 31% across benchmark runs. The regression overlaps with changes in the initialization path and is associated with a new 312ms main-thread task."

If AI is disabled, PerfSense continues to provide statistical results and evidence without any model call.

### Supported Providers

| Provider | Default Model | API Key |
|---|---|---|
| OpenAI | `gpt-4o-mini` | Required |
| Anthropic | `claude-3-haiku-20240307` | Required |
| Ollama | `llama3` | Not required |

---

## Example PR Report

```text
## PerfSense AI - Performance Report

### Summary

| Metric | Baseline | Current | Delta | Status |
|---|---:|---:|---:|---|
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

The LCP regression appears to be caused by commit
a1b2c3d which added a layout recalculation.

</details>

<details>
<summary>Artifacts</summary>

- [Full results JSON](./perfsense-results.json)

</details>
```

The report is informational by default. A regression does not automatically block a pull request.

---

## CLI

### Benchmark

```bash
perfsense benchmark \
  --pages <files> \
  --runs <n> \
  --config <config> \
  --out <file>
```

### Baseline

```bash
perfsense baseline save \
  --from <results.json> \
  --out <baseline.json>

perfsense baseline load \
  --file <baseline.json>
```

### Regression Check

```bash
perfsense check \
  --baseline <baseline.json> \
  --current <results.json> \
  --statistical \
  --format json
```

### Full Report

```bash
perfsense report \
  --baseline <baseline.json> \
  --current <results.json> \
  --repository <dir> \
  --source-maps <dir>
```

Optional AI:

```bash
perfsense report \
  --baseline <baseline.json> \
  --current <results.json> \
  --ai-provider openai \
  --ai-model gpt-4o-mini
```

### Cache

```bash
perfsense cache \
  --changed-files "file1,file2,..."
```

---

## Custom Metrics

PerfSense supports application-specific metrics through plugins.

```typescript
import type { MetricPlugin } from '@perfsense/core';
import type { Page } from 'playwright';

export class MyMetric implements MetricPlugin {
  name = 'myMetric';

  async setupPage(page: Page): Promise<void> {
    // Optional setup before navigation
  }

  async extractMetric(page: Page): Promise<number | null> {
    return await page.evaluate(() => performance.now());
  }
}
```

Register the plugin through the benchmark configuration.

This allows PerfSense to work with application-specific performance metrics in addition to standard web metrics.

---

## Package Overview

| Package | Description |
|---|---|
| `@perfsense/core` | Shared types and interfaces |
| `@perfsense/statistics` | Statistical analysis and regression classification |
| `@perfsense/metrics-core` | Standard web performance metrics |
| `@perfsense/driver-playwright` | Playwright benchmark driver |
| `@perfsense/evidence-trace` | Chrome trace evidence |
| `@perfsense/evidence-network` | Network evidence |
| `@perfsense/evidence-git-diff` | Git diff evidence |
| `@perfsense/correlation-engine` | Evidence correlation and ranking |
| `@perfsense/source-mapper` | Source-map resolution |
| `@perfsense/git-blame` | Git commit and author information |
| `@perfsense/ai-provider` | OpenAI, Anthropic, and Ollama integration |
| `@perfsense/reporter-github` | GitHub PR report generation |
| `@perfsense/github-action` | GitHub Actions integration |
| `@perfsense/cli` | Command-line interface |

---

## Project Structure

```text
perfsense/
├── packages/
│   ├── core/
│   ├── statistics/
│   ├── metrics-core/
│   ├── driver-playwright/
│   ├── evidence-trace/
│   ├── evidence-network/
│   ├── evidence-git-diff/
│   ├── correlation-engine/
│   ├── source-mapper/
│   ├── git-blame/
│   ├── ai-provider/
│   ├── reporter-github/
│   ├── github-action/
│   └── cli/
├── e2e-tests/
└── examples/
    └── benchmark-pages/
```

---

## Development

```bash
pnpm install
pnpm build
pnpm lint
pnpm test
pnpm test -- --run e2e-tests/github-action.test.ts
```

---

## Design Principles

- **Compare results, don't guess.**
- **Use repeated measurements instead of single runs.**
- **Use statistics instead of arbitrary thresholds alone.**
- **Provide evidence alongside regressions.**
- **Keep AI optional.**
- **Keep enforcement optional.**
- **Keep the framework reusable across projects.**

PerfSense is designed to make performance regressions **visible, reproducible, and explainable** without requiring developers to manually profile every change.
