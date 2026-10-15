/**
 * The vocabulary of the media pipeline.
 *
 * Everything here is plain data, deliberately: the decision about *what* to do
 * with a video is pure logic that can be unit-tested without ffmpeg, and the
 * shelling out is confined to `probe.ts` and `run.ts`. That split is what makes
 * the expensive, slow, hard-to-debug part of this project reviewable.
 */

/** A normalised view of one input file, as read by ffprobe. */
export interface ProbeResult {
  readonly path: string;
  readonly container: string;
  /** Total duration in seconds, from the container. */
  readonly durationSeconds: number;
  /** Overall bitrate in bits per second, if the container reports one. */
  readonly bitrateBps: number | null;
  readonly video: VideoStream | null;
  readonly audio: AudioStream | null;
  /** True when the file has at least one usable video stream. */
  readonly hasVideo: boolean;
  /** Every stream, kept raw for diagnostics in the admin UI. */
  readonly raw: unknown;
}

export interface VideoStream {
  readonly codec: string;
  readonly profile: string | null;
  readonly level: number | null;
  readonly pixelFormat: string | null;
  readonly width: number;
  readonly height: number;
  /** Frames per second; 0 when the stream reports a variable framerate. */
  readonly fps: number;
  readonly bitrateBps: number | null;
  /** Rotation metadata in degrees, already normalised to 0/90/180/270. */
  readonly rotationDegrees: number;
}

export interface AudioStream {
  readonly codec: string;
  readonly channels: number;
  readonly sampleRate: number | null;
  readonly bitrateBps: number | null;
}

/** One rung of the adaptive bitrate ladder. */
export interface Rendition {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly videoBitrateKbps: number;
  readonly maxrateKbps: number;
  readonly bufsizeKbps: number;
  /** Audio bitrate for this rung; all rungs share one AAC encode per stream map. */
  readonly audioBitrateKbps: number;
}

/**
 * How much work the pipeline has decided to do.
 *
 *  - `copy`                        — remux only; no decode, no quality loss.
 *  - `copy-video-transcode-audio`  — the common middle case. Opus or Vorbis audio
 *                                    in an otherwise fine H.264 file would
 *                                    otherwise force a full re-encode.
 *  - `transcode`                   — decode and re-encode to the ladder.
 */
export type ProcessMode = "copy" | "copy-video-transcode-audio" | "transcode";

export interface Decision {
  readonly mode: ProcessMode;
  /** Human-readable justification, surfaced in the admin UI. */
  readonly reasons: readonly string[];
  /** Rungs to produce. Empty for `copy`, and for a single-rung transcode. */
  readonly ladder: readonly Rendition[];
  /** True when the source is taller than anything in the ladder. */
  readonly downscaling: boolean;
}

export interface Plan {
  readonly probe: ProbeResult;
  readonly decision: Decision;
}
