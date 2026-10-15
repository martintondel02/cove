/**
 * Parsing ffmpeg's progress output.
 *
 * Encoding is the one operation in Cove that can run for hours, so "is it working
 * or is it stuck?" has to be answerable. The `-progress` flag emits key=value lines
 * on the stream it is pointed at, which means progress arrives on stderr mixed in
 * with ffmpeg's logging — so this parses defensively and ignores everything it does
 * not recognise.
 *
 * Note the two different time keys ffmpeg emits. `out_time_ms` is documented as
 * microseconds despite the name; older builds emit `out_time_us`. Both are handled,
 * and `out_time` (HH:MM:SS.mmm) is the fallback.
 */

/** Keys ffmpeg emits that we care about. */
const PROGRESS_KEYS = new Set([
  "out_time_us",
  "out_time_ms",
  "out_time",
  "frame",
  "fps",
  "speed",
  "progress",
  "total_size",
  "bitrate",
]);

export interface ProgressSample {
  /** 0–100, or null when the duration is unknown. */
  readonly percent: number | null;
  readonly seconds: number | null;
  readonly speed: string | null;
  readonly done: boolean;
}

function parseTimestamp(value: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/**
 * Feed arbitrary chunks and get throttled progress callbacks.
 *
 * Throttling matters: ffmpeg emits progress several times a second, and writing
 * every sample to Postgres would generate more database traffic than the encode
 * does useful work.
 */
export class ProgressTracker {
  private buffer = "";
  private latestSeconds: number | null = null;
  private lastReportedAt = 0;

  // Fields are declared and assigned explicitly rather than using constructor
  // parameter properties. That syntax generates code, so Node's strip-only
  // TypeScript mode rejects it at runtime — and `erasableSyntaxOnly` in
  // tsconfig.base.json now catches the mistake during typecheck instead.
  private readonly durationSeconds: number;
  private readonly onProgress: (percent: number) => void;
  private readonly minimumIntervalMs: number;

  constructor(
    durationSeconds: number,
    onProgress: (percent: number) => void,
    minimumIntervalMs = 2000,
  ) {
    this.durationSeconds = durationSeconds;
    this.onProgress = onProgress;
    this.minimumIntervalMs = minimumIntervalMs;
  }

  /** Consume a chunk of ffmpeg output. Returns the newest sample seen. */
  feed(chunk: string): ProgressSample {
    this.buffer += chunk;

    // Keep the trailing partial line for the next chunk.
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    let done = false;
    let speed: string | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.includes("=")) continue;

      const separator = line.indexOf("=");
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (!PROGRESS_KEYS.has(key)) continue;

      if (key === "out_time_us") {
        const micros = Number.parseFloat(value);
        if (Number.isFinite(micros)) this.latestSeconds = micros / 1_000_000;
      } else if (key === "out_time_ms") {
        // Despite the name, this is microseconds in every current ffmpeg build, so
        // that is the assumed meaning. The name has been misread as milliseconds
        // often enough that older or third-party builds might really emit them, so
        // fall back only when microseconds would be impossible for this file —
        // i.e. the value would place the encode far beyond the video's own length.
        const raw = Number.parseFloat(value);
        if (Number.isFinite(raw)) {
          const asMicroseconds = raw / 1_000_000;
          const asMilliseconds = raw / 1_000;
          const beyondThisFile =
            this.durationSeconds > 0 && asMicroseconds > this.durationSeconds * 2;
          const plausibleAsMillis =
            this.durationSeconds <= 0 || asMilliseconds <= this.durationSeconds * 2;
          this.latestSeconds =
            beyondThisFile && plausibleAsMillis ? asMilliseconds : asMicroseconds;
        }
      } else if (key === "out_time") {
        const seconds = parseTimestamp(value);
        if (seconds !== null) this.latestSeconds = seconds;
      } else if (key === "speed") {
        speed = value;
      } else if (key === "progress" && value === "end") {
        done = true;
      }
    }

    const percent = this.percent();
    const now = Date.now();
    if (percent !== null && (done || now - this.lastReportedAt >= this.minimumIntervalMs)) {
      this.lastReportedAt = now;
      this.onProgress(done ? 100 : percent);
    }

    return { percent, seconds: this.latestSeconds, speed, done };
  }

  percent(): number | null {
    if (this.latestSeconds === null) return null;
    if (!Number.isFinite(this.durationSeconds) || this.durationSeconds <= 0) return null;
    return Math.max(0, Math.min(100, (this.latestSeconds / this.durationSeconds) * 100));
  }
}

/**
 * ffmpeg writes the progress stream wherever `-progress` points. We point it at
 * stderr so it arrives through the same callback as the log tail, which is already
 * being read for error reporting.
 */
export const PROGRESS_ARGS = ["-progress", "pipe:2", "-nostats"] as const;
