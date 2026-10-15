/**
 * Tests for ffprobe output parsing, using the shapes ffprobe actually produces.
 *
 * The parse step is separated from the subprocess so these run instantly and can
 * cover the awkward cases that are painful to reproduce with real files: rotated
 * phone video, cover art on an audio file, numbers serialised as strings, and
 * rational frame rates like "30000/1001".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProbeError, parseProbeOutput } from "./probe.ts";

const BASE_VIDEO = {
  codec_type: "video",
  codec_name: "h264",
  profile: "High",
  level: 41,
  pix_fmt: "yuv420p",
  width: 1920,
  height: 1080,
  avg_frame_rate: "30/1",
  bit_rate: "5000000",
};

function json(streams: unknown[], format: Record<string, unknown> = {}) {
  return { streams, format: { format_name: "mov,mp4", duration: "12.5", ...format } };
}

describe("stream selection", () => {
  it("reads dimensions, codec and frame rate", () => {
    const result = parseProbeOutput("/in.mp4", json([BASE_VIDEO]));
    assert.ok(result.video);
    assert.equal(result.video.codec, "h264");
    assert.equal(result.video.width, 1920);
    assert.equal(result.video.height, 1080);
    assert.equal(result.video.fps, 30);
    assert.equal(result.hasVideo, true);
  });

  it("parses a rational frame rate rather than treating it as a number", () => {
    const result = parseProbeOutput(
      "/in.mp4",
      json([{ ...BASE_VIDEO, avg_frame_rate: "30000/1001" }]),
    );
    assert.ok(result.video);
    // 29.97, not 30000 and not 0.
    assert.ok(Math.abs(result.video.fps - 29.97) < 0.01, `got ${result.video.fps}`);
  });

  it("reads numbers that ffprobe serialised as strings", () => {
    const result = parseProbeOutput(
      "/in.mp4",
      json([{ ...BASE_VIDEO, width: "1280", height: "720", bit_rate: "2500000" }]),
    );
    assert.equal(result.video?.width, 1280);
    assert.equal(result.video?.height, 720);
    assert.equal(result.video?.bitrateBps, 2_500_000);
  });

  it("ignores cover art instead of treating an audio file as video", () => {
    const coverArt = {
      codec_type: "video",
      codec_name: "mjpeg",
      width: 600,
      height: 600,
      disposition: { attached_pic: 1 },
    };
    const result = parseProbeOutput(
      "/song.mp3",
      json([coverArt, { codec_type: "audio", codec_name: "mp3", channels: 2 }]),
    );
    assert.equal(result.hasVideo, false);
    assert.equal(result.video, null);
    assert.equal(result.audio?.codec, "mp3");
  });

  it("falls back to the stream duration when the container omits one", () => {
    // Raw MPEG-TS captures routinely have no format-level duration.
    const result = parseProbeOutput(
      "/capture.ts",
      json([{ ...BASE_VIDEO, duration: "3600.5" }], { duration: undefined }),
    );
    assert.equal(result.durationSeconds, 3600.5);
  });

  it("reports zero duration rather than NaN when nothing declares one", () => {
    const result = parseProbeOutput("/odd.bin", json([BASE_VIDEO], { duration: undefined }));
    assert.equal(result.durationSeconds, 0);
  });
});

describe("rotation", () => {
  it("swaps dimensions for a 90° display matrix", () => {
    // Portrait phone video is commonly stored landscape plus a rotation flag.
    // Ignoring it serves every vertical video sideways.
    const result = parseProbeOutput(
      "/phone.mp4",
      json([{ ...BASE_VIDEO, width: 1920, height: 1080, tags: { rotate: "90" } }]),
    );
    assert.equal(result.video?.width, 1080);
    assert.equal(result.video?.height, 1920);
    // Rotation is folded in, so downstream code sees one honest geometry.
    assert.equal(result.video?.rotationDegrees, 0);
  });

  it("swaps dimensions for a 270° rotation too", () => {
    const result = parseProbeOutput(
      "/phone.mp4",
      json([{ ...BASE_VIDEO, width: 1920, height: 1080, tags: { rotate: "270" } }]),
    );
    assert.equal(result.video?.width, 1080);
    assert.equal(result.video?.height, 1920);
  });

  it("leaves 180° alone, which does not change the aspect ratio", () => {
    const result = parseProbeOutput(
      "/phone.mp4",
      json([{ ...BASE_VIDEO, tags: { rotate: "180" } }]),
    );
    assert.equal(result.video?.width, 1920);
    assert.equal(result.video?.height, 1080);
  });

  it("also reads rotation from side_data_list, which newer ffprobe prefers", () => {
    const result = parseProbeOutput(
      "/phone.mp4",
      json([{ ...BASE_VIDEO, side_data_list: [{ rotation: -90 }] }]),
    );
    assert.equal(result.video?.width, 1080);
    assert.equal(result.video?.height, 1920);
  });
});

describe("malformed input", () => {
  it("rejects a non-object payload", () => {
    assert.throws(() => parseProbeOutput("/x", "not json"), ProbeError);
    assert.throws(() => parseProbeOutput("/x", [1, 2, 3]), ProbeError);
  });

  it("survives junk entries in the stream list", () => {
    const result = parseProbeOutput(
      "/x.mp4",
      json([null, "nonsense", 42, { codec_type: "video" }, BASE_VIDEO]),
    );
    // A video stream with no dimensions is unusable; the valid one is picked up.
    assert.equal(result.video?.width, 1920);
  });

  it("returns a video-less result for a file with no streams", () => {
    const result = parseProbeOutput("/empty.mp4", json([]));
    assert.equal(result.video, null);
    assert.equal(result.hasVideo, false);
    assert.equal(result.container, "mov,mp4");
  });
});
