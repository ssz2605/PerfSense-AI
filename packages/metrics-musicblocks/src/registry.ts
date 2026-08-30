import type { MetricPlugin } from '@perfsense/core';
import { PlaybackLatency } from './playbackLatency';
import { AudioDrift } from './audioDrift';
import { StageUpdateTime } from './stageUpdateTime';
import { BlockThroughput } from './blockThroughput';
import { ProjectLoadTime } from './projectLoadTime';
import { CallbackLatencyMean } from './callbackLatencyMean';
import { CallbackLatencyMax } from './callbackLatencyMax';
import { CumulativeDrift } from './cumulativeDrift';
import { VoiceOnsetError } from './voiceOnsetError';
import { ExecutionTime } from './executionTime';
import { MaxQueueDepth } from './maxQueueDepth';
import { BlocksExecuted } from './blocksExecuted';
import { MaxDepth } from './maxDepth';
import { HeapAfterBoot } from './heapAfterBoot';
import { MemoryDelta } from './memoryDelta';
import { RetainedHeap } from './retainedHeap';
import { SaveTime } from './saveTime';
import { ExportMIDITime } from './exportMIDITime';
import { BootstrapTotal } from './bootstrapTotal';
import { InitTotal } from './initTotal';

/**
 * Every music-blocks seam metric, keyed by lowercase name so lookups are
 * case-insensitive. Shared by the benchmark, check, and report commands so the
 * set of known metrics lives in one place.
 */
export const MUSICBLOCKS_PLUGIN_REGISTRY: Record<string, new () => MetricPlugin> = {
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
  bootstraptotal: BootstrapTotal,
  inittotal: InitTotal
};