/**
 * ffprobe: turn an arbitrary media file into a `ProbeResult`.
 *
 * The parsing is defensive on purpose. ffprobe's JSON is loosely typed, field
 * presence varies by container and codec, and this runs on whatever a user
 * uploaded — including deliberately malformed files. Every field is read through
 * a guard, and anything unreadable degrades to a null rather than throwing, so a
 * weird file produces a *decision* ("transcode it") instead of a crash.
 */
import { CommandError, run } from "./run.ts";
import type { AudioStream, ProbeResult, VideoStream } from "./types.ts";

export interface ProbeOptions {
  readonly ffprobePath?: string;
  /** ffprobe is fast, but a malformed file can still hang it. */
  readonly timeoutMs?: number;
}

export class ProbeError extends Error {
  override readonly name = "ProbeError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // ffprobe emits numbers as strings surprisingly often.
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Parse "30000/1001" style rationals, which is how ffprobe reports frame rates. */
function parseRational(value: unknown): number {
  const raw = asString(value);
  if (!raw) return 0;
  const [numerator, denominator] = raw.split("/").map((part) => Number.parseFloat(part));
  if (numerator === undefined || !Number.isFinite(numerator)) return 0;
  if (denominator === undefined || !Number.isFinite(denominator) || denominator === 0) {
    return numerator;
  }
  return numerator / denominator;
}

/**
 * Rotation from the container's display matrix, normalised to 0/90/180/270.
 *
 * This matters more than it looks: a phone video shot in portrait is often stored
 * as landscape pixels plus a 90° rotation flag, so ignoring it means every
 * vertical video is served sideways.
 */
function parseRotation(stream: Record<string, unknown>): number {
  const tags = isRecord(stream["tags"]) ? stream["tags"] : null;
  const raw = tags ? asString(tags["rotate"]) : null;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return ((parsed % 360) + 360) % 360;
  }

  // Newer ffprobe exposes it as a side_data_list entry instead of a tag.
  const sideData = stream["side_data_list"];
  if (Array.isArray(sideData)) {
    for (const entry of sideData) {
      if (!isRecord(entry)) continue;
      const rotation = asNumber(entry["rotation"]);
      if (rotation !== null) return ((Math.round(rotation) % 360) + 360) % 360;
    }
  }
  return 0;
}

function parseVideoStream(stream: Record<string, unknown>): VideoStream | null {
  const width = asNumber(stream["width"]);
  const height = asNumber(stream["height"]);
  if (!width || !height) return null;

  return {
    codec: asString(stream["codec_name"]) ?? "unknown",
    profile: asString(stream["profile"]),
    level: asNumber(stream["level"]),
    pixelFormat: asString(stream["pix_fmt"]),
    width,
    height,
    fps: parseRational(stream["avg_frame_rate"]) || parseRational(stream["r_frame_rate"]),
    bitrateBps: asNumber(stream["bit_rate"]),
    rotationDegrees: parseRotation(stream),
  };
}

function parseAudioStream(stream: Record<string, unknown>): AudioStream | null {
  const codec = asString(stream["codec_name"]);
  if (!codec) return null;
  return {
    codec,
    channels: asNumber(stream["channels"]) ?? 0,
    sampleRate: asNumber(stream["sample_rate"]),
    bitrateBps: asNumber(stream["bit_rate"]),
  };
}

/**
 * Apply the display matrix to reported dimensions.
 *
 * A 90°/270° rotation means the *stored* width and height are swapped relative to
 * how the video is meant to be seen, so swap them here and report zero rotation,
 * letting the rest of the pipeline reason about a single, honest geometry.
 */
function applyRotation(video: VideoStream): VideoStream {
  if (video.rotationDegrees !== 90 && video.rotationDegrees !== 270) return video;
  return {
    ...video,
    width: video.height,
    height: video.width,
    rotationDegrees: 0,
  };
}

export async function probe(
  path: string,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const bin = options.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe";

  let result;
  try {
    result = await run(
      bin,
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-i",
        path,
      ],
      { timeoutMs: options.timeoutMs ?? 60_000 },
    );
  } catch (error) {
    throw new ProbeError(
      `Could not run ${bin}. Is ffmpeg installed?\n${(error as Error).message}`,
    );
  }

  if (result.code !== 0) {
    throw new ProbeError(
      `ffprobe could not read "${path}". The file may be corrupt or not a media file.\n` +
        result.stderr.trim().split("\n").slice(-4).join("\n"),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new ProbeError(`ffprobe returned output that is not JSON for "${path}".`);
  }

  return parseProbeOutput(path, parsed);
}

/**
 * Turn ffprobe's JSON into a `ProbeResult`.
 *
 * Separated from the spawning so it can be tested directly against the awkward
 * real-world shapes: string-typed numbers, rational frame rates, rotated phone
 * video, and cover art masquerading as a video stream.
 */
export function parseProbeOutput(path: string, parsed: unknown): ProbeResult {
  if (!isRecord(parsed)) {
    throw new ProbeError(`ffprobe returned an unexpected shape for "${path}".`);
  }

  const streams = Array.isArray(parsed["streams"]) ? parsed["streams"] : [];
  const format = isRecord(parsed["format"]) ? parsed["format"] : {};

  let video: VideoStream | null = null;
  let audio: AudioStream | null = null;
  let streamDuration = 0;

  for (const entry of streams) {
    if (!isRecord(entry)) continue;
    const type = asString(entry["codec_type"]);
    if (type === "video" && video === null) {
      // Cover art is also tagged `video`, and it would otherwise be mistaken for
      // the main stream on an audio-only file. `attached_pic` is a number, not a
      // string, which is an easy thing to get wrong here.
      const disposition = isRecord(entry["disposition"]) ? entry["disposition"] : null;
      const isAttachedPicture = disposition
        ? asNumber(disposition["attached_pic"]) === 1
        : false;

      const candidate = parseVideoStream(entry);
      if (candidate && !isAttachedPicture) {
        video = applyRotation(candidate);
        streamDuration = asNumber(entry["duration"]) ?? 0;
      }
    } else if (type === "audio" && audio === null) {
      audio = parseAudioStream(entry);
    }
  }

  // Prefer the container's duration; fall back to the video stream's, because
  // some containers (notably raw MPEG-TS captures) omit the format-level one.
  const durationSeconds = asNumber(format["duration"]) ?? streamDuration;

  return {
    path,
    container: asString(format["format_name"]) ?? "unknown",
    durationSeconds,
    bitrateBps: asNumber(format["bit_rate"]),
    video,
    audio,
    hasVideo: video !== null,
    raw: parsed,
  };
}

/** Convenience for callers that want the friendly failure message. */
export { CommandError };
