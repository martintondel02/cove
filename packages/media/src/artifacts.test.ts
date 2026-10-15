/**
 * Tests for the derived-artefact builders: poster frame, ambient colour, and the
 * scrubber sprite sheet with its WebVTT index.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  averageColorArgs,
  buildSpriteVtt,
  parseAverageColor,
  posterArgs,
  posterTimestamp,
  spriteArgs,
  spriteSheetCount,
} from "./artifacts.ts";

describe("poster frame", () => {
  it("grabs from 10% in, not from the very first frame", () => {
    // Opening frames are frequently a fade from black or a title card.
    assert.equal(posterTimestamp(100), 10);
    assert.equal(posterTimestamp(600), 30); // clamped
  });

  it("never seeks to zero, and never past 30s", () => {
    assert.equal(posterTimestamp(0.5), 1);
    assert.equal(posterTimestamp(0), 0); // unknown duration: no seek at all
    assert.equal(posterTimestamp(3600), 30);
  });

  it("survives a NaN duration without producing an invalid seek", () => {
    assert.equal(posterTimestamp(Number.NaN), 0);
  });

  it("seeks before -i so a two-hour file is not decoded from the start", () => {
    const args = posterArgs("/in.mp4", { output: "/out/poster.webp", durationSeconds: 100 });
    const seekIndex = args.indexOf("-ss");
    const inputIndex = args.indexOf("-i");
    assert.ok(seekIndex !== -1 && seekIndex < inputIndex, "-ss must precede -i");
    assert.equal(args[args.indexOf("-frames:v") + 1], "1");
    assert.ok(args.includes("libwebp"));
  });
});

describe("ambient colour", () => {
  it("formats raw RGB as a hex colour", () => {
    assert.equal(parseAverageColor(Uint8Array.from([232, 115, 74])), "#e8734a");
    assert.equal(parseAverageColor(Uint8Array.from([0, 0, 0])), "#000000");
    assert.equal(parseAverageColor(Uint8Array.from([255, 255, 255])), "#ffffff");
  });

  it("pads single-digit channels instead of emitting a malformed colour", () => {
    assert.equal(parseAverageColor(Uint8Array.from([1, 2, 3])), "#010203");
  });

  it("returns null rather than guessing on truncated output", () => {
    assert.equal(parseAverageColor(Uint8Array.from([1, 2])), null);
    assert.equal(parseAverageColor(new Uint8Array(0)), null);
  });

  it("writes rawvideo to a file, because the runner reads stdout as text", () => {
    const args = averageColorArgs("/in.mp4", "/out/avg.rgb", 2.5);
    assert.equal(args[args.indexOf("-f") + 1], "rawvideo");
    assert.equal(args[args.indexOf("-pix_fmt") + 1], "rgb24");
    // The output goes to a path, never to stdout: three raw bytes would be
    // mangled by the text decoder in run().
    assert.equal(args[args.length - 1], "/out/avg.rgb");
    assert.ok(!args.includes("-"), "must not ask ffmpeg to write to stdout");
  });
});

describe("sprite sheet", () => {
  it("tiles thumbnails in one image request rather than hundreds", () => {
    const args = spriteArgs("/in.mp4", { outputPattern: "/out/sheet_%03d.jpg", durationSeconds: 600 });
    const filter = args[args.indexOf("-vf") + 1] ?? "";
    assert.match(filter, /fps=1\/10/);
    assert.match(filter, /tile=10x10/);
    assert.match(filter, /scale=160:-2/);
  });

  it("counts the sheets it will produce", () => {
    // 600s at 1 per 10s = 60 frames; 100 per sheet = 1 sheet.
    assert.equal(spriteSheetCount(600), 1);
    // 1500s = 150 frames → 2 sheets.
    assert.equal(spriteSheetCount(1500), 2);
    // Degenerate durations still yield one sheet.
    assert.equal(spriteSheetCount(5), 1);
  });
});

describe("sprite WebVTT index", () => {
  const vtt = buildSpriteVtt({
    durationSeconds: 30,
    intervalSeconds: 10,
    thumbWidth: 160,
    thumbHeight: 90,
  });

  it("starts with the required header", () => {
    assert.ok(vtt.startsWith("WEBVTT\n\n"));
  });

  it("emits one cue per thumbnail, using the #xywh media fragment", () => {
    // 30s at 10s intervals = 3 frames.
    const cues = vtt.match(/-->/g) ?? [];
    assert.equal(cues.length, 3);
    assert.match(vtt, /sheet_000\.jpg#xywh=0,0,160,90/);
    assert.match(vtt, /sheet_000\.jpg#xywh=160,0,160,90/);
    assert.match(vtt, /sheet_000\.jpg#xywh=320,0,160,90/);
  });

  it("uses HH:MM:SS.mmm timestamps", () => {
    assert.match(vtt, /00:00:00\.000 --> 00:00:10\.000/);
    assert.match(vtt, /00:00:20\.000 --> 00:00:30\.000/);
  });

  it("rolls over to the next sheet after the grid is full", () => {
    // 100 per sheet: frame 100 must reference sheet 001, at its origin.
    const big = buildSpriteVtt({
      durationSeconds: 1010,
      intervalSeconds: 10,
      thumbWidth: 160,
      thumbHeight: 90,
    });
    assert.match(big, /sheet_001\.jpg#xywh=0,0,160,90/);
  });

  it("wraps to the next row once a row is full", () => {
    const wide = buildSpriteVtt({
      durationSeconds: 110,
      intervalSeconds: 10,
      columns: 10,
      rows: 10,
      thumbWidth: 160,
      thumbHeight: 90,
    });
    // Frame 10 is the first tile of the second row.
    assert.match(wide, /sheet_000\.jpg#xywh=0,90,160,90/);
  });

  it("clamps the final cue to the real duration rather than overrunning", () => {
    const short = buildSpriteVtt({
      durationSeconds: 25,
      intervalSeconds: 10,
      thumbWidth: 160,
      thumbHeight: 90,
    });
    assert.match(short, /00:00:20\.000 --> 00:00:25\.000/);
  });
});
