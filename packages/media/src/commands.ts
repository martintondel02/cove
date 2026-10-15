/**
 * ffmpeg argument construction.
 *
 * Pure functions returning argument arrays — no I/O, so the expensive part of the
 * pipeline (what exactly are we asking ffmpeg to do?) is unit-testable without
 * running ffmpeg at all.
 *
 * Three decisions worth understanding:
 *
 *  1. **One process, one decode, N encodes.** All renditions are produced by a
 *     single ffmpeg invocation using `split` in `-filter_complex`. Decoding once
 *     instead of once per rendition is the biggest cost saving available here.
 *  2. **Keyframes are aligned deliberately** (`-g`, `-keyint_min`, `-sc_threshold 0`,
 *     `-force_key_frames`). Adaptive bitrate switching only works if every
 *     rendition has an IDR frame at the same timestamps; Apple's HLS spec
 *     requires one at each segment start.
 *  3. **fMP4/CMAF segments, not MPEG-TS.** Smaller, and required for the
 *     low-latency path later.
 */
import type { Rendition } from "./types.ts";

/** Video encoders we can drive, and whether they are hardware-backed. */
export type EncoderKind = "libx264" | "h264_nvenc" | "h264_qsv";

export const ENCODER_KINDS: readonly EncoderKind[] = ["libx264", "h264_nvenc", "h264_qsv"];

export function encoderKindFromEnv(value: string | undefined): EncoderKind {
  const normalised = (value ?? "").trim().toLowerCase();
  if (normalised === "nvenc" || normalised === "h264_nvenc") return "h264_nvenc";
  if (normalised === "qsv" || normalised === "h264_qsv") return "h264_qsv";
  return "libx264";
}

/**
 * Per-encoder flags.
 *
 * Hardware encoders produce slightly worse quality per bit than x264, so they
 * rely on the bitrate ladder having been set with that in mind (see ladder.ts,
 * which is deliberately conservative). VAAPI is absent on purpose: it has no CRF
 * mode, so it would need a different rate-control strategy to be worth using.
 */
export function encoderArgs(kind: EncoderKind): string[] {
  switch (kind) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "23"];
    case "h264_qsv":
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23"];
    case "libx264":
      // `veryfast` + capped CRF is the right trade at this scale: two-pass ABR
      // buys little, and per-title analysis costs more than it saves.
      return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-threads", "0"];
  }
}

export interface HlsOutputOptions {
  readonly variantCount: number;
  readonly hasAudio: boolean;
  readonly isReel?: boolean;
}

/**
 * The shared HLS muxer tail.
 *
 * `independent_segments` + `temp_file` matter for different reasons:
 *  - independent_segments: every segment starts with a keyframe, so a player can
 *    switch rendition at any boundary.
 *  - temp_file: segments are written as `.tmp` and renamed, so a half-written
 *    segment is never visible to a player or picked up by a partial copy.
 */
export function hlsOutputArgs(options: HlsOutputOptions): string[] {
  const segmentSeconds = options.isReel ? 2 : 4;

  const args = [
    "-f",
    "hls",
    "-hls_time",
    String(segmentSeconds),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_flags",
    "independent_segments+temp_file",
    "-hls_segment_filename",
    "v%v/seg_%05d.m4s",
    "-master_pl_name",
    "master.m3u8",
  ];

  // `%v` in the pattern above expands to the variant index declared here, and the
  // video/audio stream pairing is what keeps each rendition's audio alongside it.
  const streams = Array.from({ length: options.variantCount }, (_, index) =>
    options.hasAudio ? `v:${index},a:${index}` : `v:${index}`,
  );
  args.push("-var_stream_map", streams.join(" "));
  args.push("v%v/index.m3u8");
  return args;
}

/** Keyframe interval in seconds per content shape. */
export function keyframeSeconds(isReel: boolean | undefined): number {
  return isReel ? 1 : 2;
}

function gopSize(fps: number, isReel: boolean | undefined): number {
  const seconds = keyframeSeconds(isReel);
  // 48 is the safe default for the usual 24fps content when fps is unknown.
  if (!Number.isFinite(fps) || fps <= 0) return seconds * 24;
  return Math.max(1, Math.round(fps * seconds));
}

export interface EncodeOptions {
  readonly input: string;
  readonly hasAudio: boolean;
  readonly isReel?: boolean;
  readonly encoder?: EncoderKind;
  readonly fps?: number;
}

/**
 * Remux without re-encoding.
 *
 * Used when the source is already H.264 + AAC. Takes seconds and loses nothing.
 * `-bsf:a aac_adtstoasc` is deliberately absent: it is required when converting
 * MPEG-TS to MP4, but this path produces fMP4 from an already-MP4-ish source, and
 * adding the bitstream filter to an MP4 input is an error.
 */
export function buildCopyArgs(options: EncodeOptions): string[] {
  const args = ["-hide_banner", "-nostdin", "-y", "-i", options.input];
  args.push("-map", "0:v:0");
  if (options.hasAudio) args.push("-map", "0:a:0?");
  args.push("-c", "copy");
  // Force fast-start-style ordering is unnecessary for HLS segments, but the
  // pixel format is passed through untouched here because nothing is decoded.
  args.push(
    ...hlsOutputArgs({
      variantCount: 1,
      hasAudio: options.hasAudio,
      isReel: options.isReel,
    }),
  );
  return args;
}

/**
 * Keep the video bitstream, re-encode only the audio.
 *
 * The middle case, and a genuinely common one: a file that is perfect H.264 with
 * Opus or Vorbis audio (screen recorders, WebM exports) would otherwise be
 * re-encoded in full just to fix the audio track.
 */
export function buildCopyVideoArgs(options: EncodeOptions): string[] {
  const args = ["-hide_banner", "-nostdin", "-y", "-i", options.input];
  args.push("-map", "0:v:0", "-c:v", "copy");
  if (options.hasAudio) {
    args.push("-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2");
  }
  args.push(
    ...hlsOutputArgs({
      variantCount: 1,
      hasAudio: options.hasAudio,
      isReel: options.isReel,
    }),
  );
  return args;
}

export interface TranscodeOptions extends EncodeOptions {
  readonly ladder: readonly Rendition[];
}

/**
 * Transcode to the full ladder in one pass.
 *
 * Refuses an empty ladder rather than silently producing an empty playlist: that
 * combination means the caller skipped `decide()`, and failing loudly is better
 * than an upload that "succeeds" into an unwatchable post.
 */
export function buildTranscodeArgs(options: TranscodeOptions): string[] {
  if (options.ladder.length === 0) {
    throw new Error(
      "buildTranscodeArgs needs at least one rendition. Use buildCopyArgs for a remux.",
    );
  }

  const ladder = options.ladder;
  const count = ladder.length;

  const filters: string[] = [];
  const splitLabels = ladder.map((_, index) => `[s${index}]`).join("");
  filters.push(`[0:v]split=${count}${splitLabels}`);
  for (const [index, rung] of ladder.entries()) {
    // Scale by height, never width: it keeps the rung's ceiling honest for both
    // landscape and portrait, and `-2` guarantees an even width, which H.264
    // requires.
    filters.push(`[s${index}]scale=-2:${rung.height}[v${index}]`);
  }

  const args = ["-hide_banner", "-nostdin", "-y", "-i", options.input];
  args.push("-filter_complex", filters.join(";"));

  const encoder = options.encoder ?? "libx264";
  const base = encoderArgs(encoder);
  // Separate the codec/tuning flags from the `-c:v` that must carry a stream
  // index, so each rendition's bitrate applies to the right stream.
  const codecFlagIndex = base.indexOf("-c:v");
  const codecName = base[codecFlagIndex + 1] ?? "libx264";
  const tuning = base.filter((_, index) => index !== codecFlagIndex && index !== codecFlagIndex + 1);

  for (const [index, rung] of ladder.entries()) {
    args.push("-map", `[v${index}]`);
    args.push(`-c:v:${index}`, codecName, ...tuning);
    args.push(`-b:v:${index}`, `${rung.videoBitrateKbps}k`);
    args.push(`-maxrate:v:${index}`, `${rung.maxrateKbps}k`);
    args.push(`-bufsize:v:${index}`, `${rung.bufsizeKbps}k`);
  }

  if (options.hasAudio) {
    // One audio map per rendition, so each variant is self-contained.
    for (let index = 0; index < count; index += 1) args.push("-map", "0:a:0");
    args.push("-c:a", "aac", "-ac", "2");
    for (const [index, rung] of ladder.entries()) {
      args.push(`-b:a:${index}`, `${rung.audioBitrateKbps}k`);
    }
  }

  const gop = gopSize(options.fps ?? 0, options.isReel);
  const keyframeExpr = `expr:gte(t,n_forced*${keyframeSeconds(options.isReel)})`;

  args.push(
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-g",
    String(gop),
    "-keyint_min",
    String(gop),
    // Without this, x264 inserts keyframes freely and the renditions stop being
    // switchable at segment boundaries.
    "-sc_threshold",
    "0",
    "-force_key_frames",
    keyframeExpr,
  );

  args.push(
    ...hlsOutputArgs({
      variantCount: count,
      hasAudio: options.hasAudio,
      isReel: options.isReel,
    }),
  );
  return args;
}
