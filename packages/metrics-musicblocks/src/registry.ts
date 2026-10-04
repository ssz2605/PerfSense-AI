import type { MetricPlugin } from "@perfsense/core";
import { PlaybackLatency } from "./playbackLatency";
import { AudioDrift } from "./audioDrift";
import { StageUpdateTime } from "./stageUpdateTime";
import { BlockThroughput } from "./blockThroughput";
import { ProjectLoadTime } from "./projectLoadTime";
import { CallbackLatencyMean } from "./callbackLatencyMean";
import { CallbackLatencyMax } from "./callbackLatencyMax";
import { CumulativeDrift } from "./cumulativeDrift";
import { VoiceOnsetError } from "./voiceOnsetError";
import { ExecutionTime } from "./executionTime";
import { MaxQueueDepth } from "./maxQueueDepth";
import { BlocksExecuted } from "./blocksExecuted";
import { MaxDepth } from "./maxDepth";
import { HeapAfterBoot } from "./heapAfterBoot";
import { MemoryDelta } from "./memoryDelta";
import { RetainedHeap } from "./retainedHeap";
import { SaveTime } from "./saveTime";
import { ExportMIDITime } from "./exportMIDITime";
import { SaveAsLilypondTime } from "./saveAsLilypondTime";
import { BootstrapTotal } from "./bootstrapTotal";
import { InitTotal } from "./initTotal";
import { ScheduleLagMean } from "./scheduleLagMean";
import { ScheduleLagMax } from "./scheduleLagMax";
import { ScheduleCount } from "./scheduleCount";
import { MaxLogicalDepth } from "./maxLogicalDepth";
import { StageUpdateMax } from "./stageUpdateMax";
import { StageUpdateCallCount } from "./stageUpdateCallCount";
import { CacheRebuildCount } from "./cacheRebuildCount";
import { ViewportCulledBlocks } from "./viewportCulledBlocks";
import { TransportEventRatio } from "./transportEventRatio";
import { SynthsRetained } from "./synthsRetained";
import { LogoSoundsRetained } from "./logoSoundsRetained";
import { CanvasInkCoverage } from "./canvasInkCoverage";
import { CanvasInkDrift } from "./canvasInkDrift";
import { RetainedHeapSlope } from "./retainedHeapSlope";
import { PeakHeapDuringExport } from "./peakHeapDuringExport";
import { TransportEventCount } from "./transportEventCount";
import { CacheSkippedCount } from "./cacheSkippedCount";
import { ViewportCulledFraction } from "./viewportCulledFraction";
import { RefreshCanvasCallCount } from "./refreshCanvasCallCount";

/**
 * Every music-blocks seam metric, keyed by lowercase name so lookups are
 * case-insensitive. Shared by the benchmark, check, and report commands so the
 * set of known metrics lives in one place.
 */
export const MUSICBLOCKS_PLUGIN_REGISTRY: Record<
  string,
  new () => MetricPlugin
> = {
  playbacklatency: PlaybackLatency,
  audiodrift: AudioDrift,
  stageupdatetime: StageUpdateTime,
  blockthroughput: BlockThroughput,
  projectloadtime: ProjectLoadTime,
  callbacklatencymean: CallbackLatencyMean,
  callbacklatencymax: CallbackLatencyMax,
  cumulativedrift: CumulativeDrift,
  voiceonseterror: VoiceOnsetError,
  executiontime: ExecutionTime,
  maxqueuedepth: MaxQueueDepth,
  blocksexecuted: BlocksExecuted,
  maxdepth: MaxDepth,
  heapafterboot: HeapAfterBoot,
  memorydelta: MemoryDelta,
  retainedheap: RetainedHeap,
  savetime: SaveTime,
  exportmiditime: ExportMIDITime,
  saveaslilypondtime: SaveAsLilypondTime,
  bootstraptotal: BootstrapTotal,
  inittotal: InitTotal,
  schedulelagmean: ScheduleLagMean,
  schedulelagmax: ScheduleLagMax,
  schedulecount: ScheduleCount,
  maxlogicaldepth: MaxLogicalDepth,
  stageupdatemax: StageUpdateMax,
  stageupdatecallcount: StageUpdateCallCount,
  cacherebuildcount: CacheRebuildCount,
  viewportculledblocks: ViewportCulledBlocks,
  transporteventratio: TransportEventRatio,
  transporteventcount: TransportEventCount,
  synthsretained: SynthsRetained,
  cacheskippedcount: CacheSkippedCount,
  viewportculledfraction: ViewportCulledFraction,
  refreshcanvascallcount: RefreshCanvasCallCount,
  logosoundsretained: LogoSoundsRetained,
  canvasinkcoverage: CanvasInkCoverage,
  canvasinkdrift: CanvasInkDrift,
  retainedheapslope: RetainedHeapSlope,
  peakheapduringexport: PeakHeapDuringExport,
};
