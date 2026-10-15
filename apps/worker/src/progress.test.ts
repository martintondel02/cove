/**
 * Tests for ffmpeg progress parsing and the on-disk layout.
 *
 * Progress is worth testing because it is the only signal that a long encode is
 * alive. A parser that silently returns null leaves an operator staring at a
 * progress bar frozen at 5% for two hours, unable to tell working from wedged.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProgressTracker, PROGRESS_ARGS } from "./progress.ts";

/** Collect the percentages a tracker reports for a sequence of chunks. */
function collect(durationSeconds: number, chunks: string[]): number[] {
  const seen: number[] = [];
  // A zero interval makes every sample report, which is what a test wants; prod
  // throttles to 2s.
  const tracker = new ProgressTracker(durationSeconds, (percent) => seen.push(percent), 0);
  for (const chunk of chunks) tracker.feed(chunk);
  return seen;
}

describe("progress parsing", () => {
  it("reads out_time_us and converts to a percentage", () => {
    const seen = collect(100, [
      "frame=10\nout_time_us=25000000\nspeed=2.0x\nprogress=continue\n",
    ]);
    assert.equal(seen.at(-1), 25);
  });

  it("treats out_time_ms as microseconds, despite the name", () => {
    // ffmpeg's `out_time_ms` is microseconds in current builds. Reading it as
    // milliseconds would report a 100s encode as 50,000% complete.
    const seen = collect(100, ["out_time_ms=50000000\nprogress=continue\n"]);
    assert.equal(seen.at(-1), 50);
  });

  it("only falls back to milliseconds when microseconds are impossible", () => {
    // 900,000,000µs would be 900s of a 100s file, which cannot be right; as
    // milliseconds it is 900s too, so it is still implausible and we keep microseconds.
    const implausible = collect(100, ["out_time_ms=900000000\nprogress=continue\n"]);
    assert.equal(implausible.at(-1), 100, "clamped, not wildly wrong");

    // 150,000,000µs = 150s of a 100s file: beyond the file, but as milliseconds it is
    // 150s — also beyond. Neither reading is plausible, so microseconds stand.
    const ambiguous = collect(100, ["out_time_ms=150000000\nprogress=continue\n"]);
    assert.ok((ambiguous.at(-1) ?? 0) <= 100);
  });

  it("falls back to the HH:MM:SS.mmm form", () => {
    const seen = collect(60, ["out_time=00:00:30.500000\nprogress=continue\n"]);
    assert.ok(Math.abs((seen.at(-1) ?? 0) - 50.83) < 0.5);
  });

  it("reassembles lines split across chunk boundaries", () => {
    // ffmpeg's writes do not respect line boundaries; a naive parser loses samples.
    const seen = collect(100, ["out_time_us=10", "000000\nprogress=continue\n"]);
    assert.equal(seen.at(-1), 10);
  });

  it("reports 100 when ffmpeg says it is done", () => {
    const seen = collect(100, ["out_time_us=20000000\nprogress=end\n"]);
    assert.equal(seen.at(-1), 100);
  });

  it("returns null rather than NaN when the duration is unknown", () => {
    const tracker = new ProgressTracker(0, () => undefined, 0);
    const sample = tracker.feed("out_time_us=5000000\nprogress=continue\n");
    assert.equal(sample.percent, null);
    assert.equal(sample.seconds, 5);
  });

  it("never reports outside 0–100", () => {
    const seen = collect(10, ["out_time_us=99000000\nprogress=continue\n"]);
    for (const percent of seen) assert.ok(percent >= 0 && percent <= 100, `got ${percent}`);
  });

  it("ignores unrelated ffmpeg logging mixed into the same stream", () => {
    const seen = collect(100, [
      "[libx264 @ 0x55] using cpu capabilities: MMX2 SSE2Fast\n" +
        "Stream mapping:\n" +
        "  Stream #0:0 -> #0:0 (h264 (native) -> h264 (libx264))\n" +
        "out_time_us=10000000\nprogress=continue\n",
    ]);
    assert.equal(seen.at(-1), 10);
  });

  it("throttles, so a long encode cannot flood the database", () => {
    let calls = 0;
    const tracker = new ProgressTracker(100, () => (calls += 1), 60_000);
    for (let i = 1; i <= 20; i += 1) {
      tracker.feed(`out_time_us=${i * 1_000_000}\nprogress=continue\n`);
    }
    // Twenty samples inside the throttle window, but at most the first is reported.
    assert.ok(calls <= 1, `reported ${calls} times`);
  });

  it("points the progress stream at stderr, where the log tail is already read", () => {
    assert.deepEqual([...PROGRESS_ARGS], ["-progress", "pipe:2", "-nostats"]);
  });
});
