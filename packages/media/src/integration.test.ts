/**
 * Integration tests that actually run ffmpeg and ffprobe.
 *
 * Everything else in this package is pure logic; this file exists because the
 * argument builders are only correct if ffmpeg *agrees* with them. An invalid
 * `-var_stream_map`, a bad `-hls_flags` combination, or a segment pattern that does
 * not expand produces a failure deep inside a long encode — on a user's machine,
 * hours after the mistake was made.
 *
 * Skipped automatically where the binaries are missing, so `pnpm test` still works
 * on a bare checkout. The transcode case additionally requires libx264, which is
 * present in the worker image and in CI but not on every developer machine (Fedora
 * ships ffmpeg-free, which has no libx264).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { buildCopyArgs, buildTranscodeArgs } from "./commands.ts";
import { decide } from "./decide.ts";
import { RENDITIONS_16_9 } from "./ladder.ts";
import { probe } from "./probe.ts";
import { binaryAvailable, run, runOrThrow } from "./run.ts";

const hasFfmpeg = await binaryAvailable("ffmpeg");
const hasFfprobe = await binaryAvailable("ffprobe");

/** Which H.264 encoder this ffmpeg actually has, if any. */
async function detectH264Encoder(): Promise<string | null> {
  if (!hasFfmpeg) return null;
  const result = await run("ffmpeg", ["-hide_banner", "-encoders"]);
  if (result.code !== 0) return null;
  // Prefer libx264: the pipeline's default, and what the worker image ships.
  if (/\blibx264\b/.test(result.stdout)) return "libx264";
  if (/\blibopenh264\b/.test(result.stdout)) return "libopenh264";
  return null;
}

const h264Encoder = await detectH264Encoder();

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cove-media-test-"));
}

/** A tiny mpeg4/AAC clip. mpeg4 is a native encoder, so this always works. */
async function makeMpeg4Clip(dir: string): Promise<string> {
  const out = join(dir, "mpeg4.mp4");
  await runOrThrow("ffmpeg", [
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "mpeg4", "-c:a", "aac", "-shortest",
    out,
  ]);
  return out;
}

/** A tiny H.264 clip, using whichever encoder is available. */
async function makeH264Clip(dir: string, audio: boolean): Promise<string> {
  const out = join(dir, "h264.mp4");
  const args = [
    "-hide_banner", "-nostdin", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=2",
  ];
  if (audio) args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=2");
  args.push(
    "-c:v", h264Encoder ?? "libx264",
    // libx264 takes -crf; libopenh264 only takes -b:v. Both accept -pix_fmt.
    ...(h264Encoder === "libx264" ? ["-crf", "28"] : ["-b:v", "300k"]),
    "-pix_fmt", "yuv420p",
  );
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push(out);
  await runOrThrow("ffmpeg", args);
  return out;
}

describe("ffprobe against a real file", { skip: !hasFfprobe }, () => {
  it("reads back the properties we wrote", async () => {
    const dir = await makeTempDir();
    try {
      const file = await makeMpeg4Clip(dir);
      const result = await probe(file);

      assert.equal(result.hasVideo, true);
      assert.equal(result.video?.codec, "mpeg4");
      assert.equal(result.video?.width, 320);
      assert.equal(result.video?.height, 240);
      // 24fps exactly; the rational parser must not turn this into 0.
      assert.equal(result.video?.fps, 24);
      assert.equal(result.audio?.codec, "aac");
      assert.ok(
        Math.abs(result.durationSeconds - 2) < 0.3,
        `duration was ${result.durationSeconds}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("decides to transcode mpeg4, which no browser plays", async () => {
    const dir = await makeTempDir();
    try {
      const file = await makeMpeg4Clip(dir);
      const decision = decide(await probe(file), { preset: "balanced" });
      assert.equal(decision.mode, "transcode");
      assert.ok(decision.ladder.length > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails with a readable message on a file that is not media", async () => {
    const dir = await makeTempDir();
    try {
      const bogus = join(dir, "not-a-video.mp4");
      await writeFile(bogus, "this is definitely not a video");
      await assert.rejects(() => probe(bogus), /could not read|corrupt|not a media/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe(
  "ffmpeg accepts the generated arguments",
  { skip: !hasFfmpeg || h264Encoder === null },
  () => {
    it("remuxes to a playable HLS ladder, creating variant directories itself", async () => {
      const dir = await makeTempDir();
      try {
        const file = await makeH264Clip(dir, true);
        const outDir = join(dir, "out");
        // Deliberately NOT creating v0/: this asserts that the HLS muxer creates
        // the directories the `%v` pattern expands into. If it did not, every job
        // would need an explicit mkdir, so it is worth pinning down.
        await mkdir(outDir, { recursive: true });

        await runOrThrow("ffmpeg", buildCopyArgs({ input: file, hasAudio: true }), {
          cwd: outDir,
        });

        const files = await readdir(outDir, { recursive: true });
        assert.ok(
          files.some((f) => f.endsWith("master.m3u8")),
          `no master playlist; got ${files.join(", ")}`,
        );
        assert.ok(files.some((f) => f.endsWith(".m4s")), "no fMP4 segments were written");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it(
      "produces every rendition from a single transcode pass",
      { skip: h264Encoder !== "libx264" },
      async () => {
        const dir = await makeTempDir();
        try {
          const file = await makeH264Clip(dir, true);
          const outDir = join(dir, "transcoded");
          await mkdir(outDir, { recursive: true });

          await runOrThrow(
            "ffmpeg",
            buildTranscodeArgs({
              input: file,
              hasAudio: true,
              ladder: [RENDITIONS_16_9["480p"]!],
              fps: 24,
            }),
            { cwd: outDir },
          );

          const files = await readdir(outDir, { recursive: true });
          assert.ok(files.some((f) => f.endsWith("master.m3u8")), "no master playlist");
          assert.ok(
            files.some((f) => f.endsWith("index.m3u8") && f.includes("v0")),
            "no variant playlist",
          );

          const segment = files.find((f) => f.endsWith(".m4s"));
          assert.ok(segment, "no media segments");
          const info = await stat(join(outDir, segment));
          assert.ok(info.size > 0, "a segment was written but is empty");

          // The point of the single-pass design: one output per rung, all present.
          const playlists = files.filter((f) => f.endsWith("index.m3u8"));
          assert.equal(playlists.length, 1, `expected 1 variant playlist, got ${playlists.length}`);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
  },
);
