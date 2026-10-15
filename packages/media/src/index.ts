export {
  ENCODER_KINDS,
  buildCopyArgs,
  buildCopyVideoArgs,
  buildTranscodeArgs,
  encoderArgs,
  encoderKindFromEnv,
  hlsOutputArgs,
  keyframeSeconds,
  type EncodeOptions,
  type EncoderKind,
  type HlsOutputOptions,
  type TranscodeOptions,
} from "./commands.ts";

export { decide, type DecideOptions } from "./decide.ts";

export {
  PRESET_LADDERS,
  RENDITIONS_16_9,
  RENDITIONS_9_16,
  fitLadderToSource,
  orientationOf,
  singleFallbackRendition,
  verticalLadder,
  type Orientation,
} from "./ladder.ts";

export {
  averageColorArgs,
  buildSpriteVtt,
  parseAverageColor,
  posterArgs,
  posterTimestamp,
  spriteArgs,
  spriteSheetCount,
  type PosterOptions,
  type SpriteOptions,
  type SpriteVttOptions,
} from "./artifacts.ts";

export { ProbeError, parseProbeOutput, probe, type ProbeOptions } from "./probe.ts";

export {
  CommandError,
  binaryAvailable,
  run,
  runOrThrow,
  type RunOptions,
  type RunResult,
} from "./run.ts";

export type {
  AudioStream,
  Decision,
  Plan,
  ProcessMode,
  ProbeResult,
  Rendition,
  VideoStream,
} from "./types.ts";
