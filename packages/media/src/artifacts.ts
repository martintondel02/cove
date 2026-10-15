/**
 * Artefacts derived from a video, besides the playable renditions.
 *
 * These are what make the difference between "a video file on a web page" and
 * something that feels like a product: a poster frame so nothing is ever a grey
 * rectangle, an ambient colour pulled from the actual footage, and a sprite sheet
 * so the scrubber shows where you are going instead of a blank track.
 *
 * All pure argument builders, except the tiny colour parser.
 */

export interface PosterOptions {
  /** Where to put the frame. */
  readonly output: string;
  /** Duration of the source, used to pick a representative moment. */
  readonly durationSeconds: number;
  /** Output width; height follows the source aspect ratio. */
  readonly width?: number;
}

/**
 * Pick the moment to grab a poster from.
 *
 * 10% in, clamped to 1–30s. The very first frames are frequently black (fades) or
 * a title card, and the very end is frequently a fade-out; 10% is reliably inside
 * the content.
 */
export function posterTimestamp(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.min(30, Math.max(1, durationSeconds * 0.1));
}

/**
 * A single frame, as WebP.
 *
 * WebP rather than JPEG because it is ~25% smaller at the same quality and is
 * supported everywhere that matters; JPEG would be the fallback if a build ever
 * lacked libwebp.
 */
export function posterArgs(input: string, options: PosterOptions): string[] {
  const at = posterTimestamp(options.durationSeconds);
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    // Fast seek before -i: decodes from the nearest keyframe rather than from the
    // start, which matters on a two-hour file.
    "-ss",
    at.toFixed(3),
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    `scale=${options.width ?? 1280}:-2`,
    "-c:v",
    "libwebp",
    "-quality",
    "80",
    options.output,
  ];
}

/**
 * The average colour of one frame, written as three raw RGB bytes.
 *
 * Scaling to 1×1 makes ffmpeg's scaler do the averaging, so no image library is
 * needed. Written to a file rather than stdout because the output is binary and
 * the process runner reads stdout as text.
 */
export function averageColorArgs(input: string, output: string, atSeconds: number): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-ss",
    Math.max(0, atSeconds).toFixed(3),
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    "scale=1:1",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    output,
  ];
}

/** Turn the 3-byte rawvideo output into a hex colour. */
export function parseAverageColor(bytes: Uint8Array): string | null {
  if (bytes.length < 3) return null;
  const [r, g, b] = [bytes[0]!, bytes[1]!, bytes[2]!];
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

export interface SpriteOptions {
  readonly outputPattern: string;
  readonly durationSeconds: number;
  /** Seconds between thumbnails. */
  readonly intervalSeconds?: number;
  readonly thumbWidth?: number;
  readonly columns?: number;
  readonly rows?: number;
}

/**
 * A contact sheet of thumbnails, as a grid of JPEGs.
 *
 * One image request for the whole scrubber rather than hundreds. `tile` does the
 * compositing inside ffmpeg.
 */
export function spriteArgs(input: string, options: SpriteOptions): string[] {
  const interval = options.intervalSeconds ?? 10;
  const width = options.thumbWidth ?? 160;
  const columns = options.columns ?? 10;
  const rows = options.rows ?? 10;

  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-vf",
    `fps=1/${interval},scale=${width}:-2,tile=${columns}x${rows}`,
    "-q:v",
    "3",
    options.outputPattern,
  ];
}

export interface SpriteVttOptions {
  readonly durationSeconds: number;
  readonly intervalSeconds?: number;
  readonly thumbWidth?: number;
  /** Height of one tile; must match what the scaler produced. */
  readonly thumbHeight: number;
  readonly columns?: number;
  readonly rows?: number;
  /** File name pattern for sheets, e.g. `sheet_%03d.jpg`. */
  readonly sheetPattern?: string;
}

function timestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/**
 * WebVTT describing where each thumbnail lives inside the sprite sheets.
 *
 * The `#xywh=` media fragment convention is what players understand; this is the
 * same trick Jellyfin and Roku use, and it means the scrubber can be built from
 * one file plus a text index.
 */
export function buildSpriteVtt(options: SpriteVttOptions): string {
  const interval = options.intervalSeconds ?? 10;
  const width = options.thumbWidth ?? 160;
  const columns = options.columns ?? 10;
  const rows = options.rows ?? 10;
  const perSheet = columns * rows;
  const pattern = options.sheetPattern ?? "sheet_%03d.jpg";

  // `ceil`, not `floor`: `fps=1/<interval>` emits a frame at t=0, t=interval, … so a
  // 25s video at a 10s interval really does produce three frames. Using floor left
  // the final partial interval without a thumbnail, so scrubbing near the end of a
  // video showed nothing at all.
  const frameCount = Math.max(1, Math.ceil(options.durationSeconds / interval));
  const lines: string[] = ["WEBVTT", ""];

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sheetIndex = Math.floor(frame / perSheet);
    const within = frame % perSheet;
    const x = (within % columns) * width;
    const y = Math.floor(within / columns) * options.thumbHeight;
    const sheetName = pattern.replace(
      /%0?(\d*)d/,
      (_match, pad: string) =>
        String(sheetIndex).padStart(pad ? Number(pad) : 1, "0"),
    );

    const start = frame * interval;
    const end = Math.min(options.durationSeconds, (frame + 1) * interval);

    lines.push(`${timestamp(start)} --> ${timestamp(end)}`);
    lines.push(`${sheetName}#xywh=${x},${y},${width},${options.thumbHeight}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** How many sheet images `spriteArgs` will produce for a given duration. */
export function spriteSheetCount(
  durationSeconds: number,
  intervalSeconds = 10,
  columns = 10,
  rows = 10,
): number {
  // Must agree with `buildSpriteVtt`: both round up, because ffmpeg emits a frame
  // at t=0 as well as one per interval.
  const frames = Math.max(1, Math.ceil(durationSeconds / intervalSeconds));
  return Math.max(1, Math.ceil(frames / (columns * rows)));
}
