# Music Blocks Custom Metrics

This directory demonstrates how to add project-specific metrics to Perfsense using the `MetricPlugin` API.

## Plugins

| Plugin | What it measures | Method |
|---|---|---|
| `playbackLatency` | Time from "play" to first audio output | Patches `__mb.startPlayback`, measures callback latency |
| `audioDrift` | Scheduler timing accuracy over 16 beats | Calls `__mb.testAudioDrift`, computes max expected-vs-actual deviation |
| `stageUpdateTime` | EaselJS `stage.update()` execution time | Patches `__mb.stage.update`, measures 20 frames, reports average |
| `blockThroughput` | Blocks executed per second | Calls `__mb.blockQueue.executeBlock` 100 times, measures elapsed |
| `projectLoadTime` | Time to fully load + parse a saved project | Calls `__mb.loadProject`, measures callback latency |

Each plugin follows the `MetricPlugin` interface from `@perfsense/core`:

```
setupPage(page)   → inject __perfsense namespace before navigation
setupPostNav(page) → activate instrumentation after page.goto() (optional hook)
extractMetric(page) → read __perfsense value after settle
```

## Pages

- `fast-project.html` — minimal mock with 3 stage children, 4 blocks, fast callbacks
- `slow-project.html` — complex mock with 50 stage children, 50+ blocks, delayed callbacks

## Adding a new MB metric

1. Create a new file in `plugins/` that implements `MetricPlugin`
2. Export it from packages/metrics-musicblocks/src/index.ts
3. Register it in perfsense.config.json under `metrics` and `thresholds`

## Running

```bash
# Compile the plugins
pnpm build

# Benchmark both pages with MB metrics
perfsense benchmark --config examples/music-blocks/perfsense.config.json
```

## API Contract for mock pages

Pages must expose `window.__mb` with these methods for plugins to work:

- `startPlayback(callback)` — simulate audio start
- `testAudioDrift(count, interval, callback)` — simulate beat scheduling
- `stage.update()` — simulate EaselJS frame render
- `blockQueue.executeBlock()` — simulate one block execution
- `loadProject(data, callback)` — simulate project file load
