/**
 * Tests for ffmpeg argument construction.
 *
 * The value here is not that ffmpeg gets sensible flags, but that specific,
 * easy-to-lose invariants survive refactoring: adaptive bitrate switching only
 * works if the renditions share keyframe timestamps, and the copy paths must never
 * accidentally acquire an encoder.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCopyArgs,
  buildCopyVideoArgs,
  buildTranscodeArgs,
  encoderArgs,
  encoderKindFromEnv,
  hlsOutputArgs,
} from "./commands.ts";
import { RENDITIONS_16_9 } from "./ladder.ts";

/** Find the value that follows a flag, e.g. the "-hls_time" value. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

const BALANCED = [RENDITIONS_16_9["720p"]!, RENDITIONS_16_9["480p"]!];

describe("hls muxer tail", () => {
  it("uses fMP4 segments with an init file", () => {
    const args = hlsOutputArgs({ variantCount: 1, hasAudio: true });
    assert.equal(valueOf(args, "-hls_segment_type"), "fmp4");
    assert.equal(valueOf(args, "-hls_fmp4_init_filename"), "init.mp4");
    assert.equal(valueOf(args, "-hls_playlist_type"), "vod");
  });

  it("marks segments independent and writes them atomically", () => {
    const flags = valueOf(hlsOutputArgs({ variantCount: 1, hasAudio: true }), "-hls_flags");
    // independent_segments is what makes rendition switching possible;
    // temp_file stops a half-written segment ever being served.
    assert.match(flags ?? "", /independent_segments/);
    assert.match(flags ?? "", /temp_file/);
  });

  it("uses 4s segments normally and 2s for reels", () => {
    assert.equal(valueOf(hlsOutputArgs({ variantCount: 1, hasAudio: true }), "-hls_time"), "4");
    assert.equal(
      valueOf(hlsOutputArgs({ variantCount: 1, hasAudio: true, isReel: true }), "-hls_time"),
      "2",
    );
  });

  it("pairs each variant with its own audio stream", () => {
    const args = hlsOutputArgs({ variantCount: 2, hasAudio: true });
    assert.equal(valueOf(args, "-var_stream_map"), "v:0,a:0 v:1,a:1");
  });

  it("drops audio from the stream map when there is none", () => {
    const args = hlsOutputArgs({ variantCount: 2, hasAudio: false });
    assert.equal(valueOf(args, "-var_stream_map"), "v:0 v:1");
  });
});

describe("copy args", () => {
  it("never invokes an encoder", () => {
    const args = buildCopyArgs({ input: "/in.mp4", hasAudio: true });
    assert.ok(args.includes("-c"));
    assert.equal(valueOf(args, "-c"), "copy");
    assert.ok(!args.some((a) => a.includes("libx264")), "copy path must not name an encoder");
    assert.ok(!args.some((a) => a.includes("crf")), "copy path must not set quality");
    assert.ok(!args.includes("-filter_complex"), "copy path must not decode");
  });

  it("maps audio optionally, since not every video has a soundtrack", () => {
    // `0:a:0?` — the trailing `?` means "if present", without which ffmpeg fails
    // outright on a silent video.
    assert.ok(buildCopyArgs({ input: "/in.mp4", hasAudio: true }).includes("0:a:0?"));
    assert.ok(!buildCopyArgs({ input: "/in.mp4", hasAudio: false }).includes("0:a:0?"));
  });
});

describe("copy-video args", () => {
  it("copies the video stream but encodes the audio to AAC", () => {
    const args = buildCopyVideoArgs({ input: "/in.webm", hasAudio: true });
    assert.equal(valueOf(args, "-c:v"), "copy");
    assert.equal(valueOf(args, "-c:a"), "aac");
    assert.ok(!args.includes("-filter_complex"), "video must not be decoded");
  });
});

describe("transcode args", () => {
  it("refuses an empty ladder instead of producing an empty playlist", () => {
    assert.throws(
      () => buildTranscodeArgs({ input: "/in.mp4", hasAudio: true, ladder: [] }),
      /at least one rendition/i,
    );
  });

  it("decodes once and splits, rather than one process per rendition", () => {
    const args = buildTranscodeArgs({ input: "/in.mp4", hasAudio: true, ladder: BALANCED });
    const filter = valueOf(args, "-filter_complex") ?? "";
    assert.match(filter, /\[0:v\]split=2\[s0\]\[s1\]/);
    assert.match(filter, /\[s0\]scale=-2:720\[v0\]/);
    assert.match(filter, /\[s1\]scale=-2:480\[v1\]/);
  });

  it("scales by height so a rung is a ceiling in both orientations", () => {
    const args = buildTranscodeArgs({ input: "/in.mp4", hasAudio: true, ladder: BALANCED });
    const filter = valueOf(args, "-filter_complex") ?? "";
    // `-2` keeps width even, which H.264 requires, and avoids letterboxing.
    assert.ok(!filter.includes("pad="), "must not pad: that would letterbox the frame");
    assert.match(filter, /scale=-2:720/);
  });

  it("gives every rendition aligned keyframes", () => {
    const args = buildTranscodeArgs({
      input: "/in.mp4",
      hasAudio: true,
      ladder: BALANCED,
      fps: 30,
      isReel: false,
    });
    // Without all three of these, renditions drift out of alignment and ABR
    // switching causes a visible stutter.
    assert.equal(valueOf(args, "-sc_threshold"), "0");
    assert.equal(valueOf(args, "-g"), "60"); // 30fps × 2s
    assert.equal(valueOf(args, "-keyint_min"), "60");
    assert.match(valueOf(args, "-force_key_frames") ?? "", /n_forced\*2/);
  });

  it("uses a 1s keyframe interval for reels", () => {
    const args = buildTranscodeArgs({
      input: "/in.mp4",
      hasAudio: true,
      ladder: BALANCED,
      fps: 24,
      isReel: true,
    });
    assert.equal(valueOf(args, "-g"), "24");
    assert.match(valueOf(args, "-force_key_frames") ?? "", /n_forced\*1/);
  });

  it("falls back to a 48-frame GOP when the frame rate is unknown", () => {
    const args = buildTranscodeArgs({ input: "/in.mp4", hasAudio: true, ladder: BALANCED });
    assert.equal(valueOf(args, "-g"), "48");
  });

  it("indexes each rendition's codec and bitrate separately", () => {
    const args = buildTranscodeArgs({ input: "/in.mp4", hasAudio: true, ladder: BALANCED });
    assert.equal(valueOf(args, "-b:v:0"), "2800k");
    assert.equal(valueOf(args, "-maxrate:v:0"), "3000k");
    assert.equal(valueOf(args, "-bufsize:v:0"), "4200k");
    assert.equal(valueOf(args, "-b:v:1"), "1200k");
    // One audio map per rendition keeps each variant self-contained.
    assert.equal(args.filter((a) => a === "0:a:0").length, 2);
    assert.equal(valueOf(args, "-b:a:0"), "128k");
    assert.equal(valueOf(args, "-b:a:1"), "96k");
  });

  it("forces 8-bit 4:2:0 output, which is what actually plays everywhere", () => {
    const args = buildTranscodeArgs({ input: "/in.mp4", hasAudio: true, ladder: BALANCED });
    assert.equal(valueOf(args, "-pix_fmt"), "yuv420p");
  });

  it("omits audio entirely for a silent source", () => {
    const args = buildTranscodeArgs({ input: "/in.mp4", hasAudio: false, ladder: BALANCED });
    assert.ok(!args.includes("0:a:0"));
    assert.equal(valueOf(args, "-var_stream_map"), "v:0 v:1");
  });

  it("passes the input as a single argv element, never a shell string", () => {
    // Media filenames come from user uploads. This asserts the shape that makes
    // command injection impossible.
    const nasty = "/uploads/; rm -rf / #.mp4";
    const args = buildTranscodeArgs({ input: nasty, hasAudio: true, ladder: BALANCED });
    assert.ok(args.includes(nasty));
    assert.equal(args.filter((a) => a === nasty).length, 1);
  });
});

describe("encoder selection", () => {
  it("defaults to libx264 with capped CRF", () => {
    assert.deepEqual(encoderKindFromEnv(undefined), "libx264");
    assert.deepEqual(encoderKindFromEnv(""), "libx264");
    assert.deepEqual(encoderKindFromEnv("garbage"), "libx264");
    const args = encoderArgs("libx264");
    assert.ok(args.includes("libx264"));
    assert.ok(args.includes("-crf"));
  });

  it("accepts the hardware aliases people actually write in .env", () => {
    assert.equal(encoderKindFromEnv("nvenc"), "h264_nvenc");
    assert.equal(encoderKindFromEnv("NVENC"), "h264_nvenc");
    assert.equal(encoderKindFromEnv("qsv"), "h264_qsv");
    assert.equal(encoderKindFromEnv("h264_qsv"), "h264_qsv");
  });

  it("gives hardware encoders rate control they actually support", () => {
    // nvenc rejects -crf; using the x264 flags on it fails outright.
    const nvenc = encoderArgs("h264_nvenc");
    assert.ok(nvenc.includes("h264_nvenc"));
    assert.ok(!nvenc.includes("-crf"));
    assert.ok(nvenc.includes("-cq"));

    const qsv = encoderArgs("h264_qsv");
    assert.ok(qsv.includes("-global_quality"));
    assert.ok(!qsv.includes("-crf"));
  });

  it("applies the chosen encoder to every rendition with a stream index", () => {
    const args = buildTranscodeArgs({
      input: "/in.mp4",
      hasAudio: true,
      ladder: BALANCED,
      encoder: "h264_nvenc",
    });
    assert.equal(valueOf(args, "-c:v:0"), "h264_nvenc");
    assert.equal(valueOf(args, "-c:v:1"), "h264_nvenc");
    assert.ok(!args.includes("libx264"));
  });
});
