/**
 * Tests for the remux-or-transcode decision.
 *
 * These matter more than most: a wrong "transcode" turns a five-second upload
 * into an hour of CPU on a small box, and a wrong "copy" hands visitors a video
 * their browser silently refuses to play. Both failures are expensive and neither
 * is obvious from the code.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decide } from "./decide.ts";
import type { AudioStream, ProbeResult, VideoStream } from "./types.ts";

function video(overrides: Partial<VideoStream> = {}): VideoStream {
  return {
    codec: "h264",
    profile: "High",
    level: 41,
    pixelFormat: "yuv420p",
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateBps: 5_000_000,
    rotationDegrees: 0,
    ...overrides,
  };
}

function audio(overrides: Partial<AudioStream> = {}): AudioStream {
  return { codec: "aac", channels: 2, sampleRate: 48_000, bitrateBps: 128_000, ...overrides };
}

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  const v = overrides.video === undefined ? video() : overrides.video;
  return {
    path: "/tmp/in.mp4",
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    durationSeconds: 60,
    bitrateBps: 5_200_000,
    video: v,
    audio: audio(),
    hasVideo: v !== null,
    raw: {},
    ...overrides,
  };
}

describe("remux path", () => {
  it("copies an already-playable file instead of re-encoding it", () => {
    const decision = decide(probe(), { preset: "balanced" });
    assert.equal(decision.mode, "copy");
    assert.deepEqual(decision.ladder, []);
    assert.equal(decision.downscaling, false);
    // The reason should be reassuring, since this is the fast path.
    assert.match(decision.reasons.join(" "), /remuxing without re-encoding/i);
  });

  it("copies H.264 with no audio at all", () => {
    const decision = decide(probe({ audio: null }), { preset: "balanced" });
    assert.equal(decision.mode, "copy");
  });

  it("treats a constrained baseline profile as playable", () => {
    const decision = decide(probe({ video: video({ profile: "Constrained Baseline" }) }), {
      preset: "balanced",
    });
    assert.equal(decision.mode, "copy");
  });

  it("tolerates a missing profile and pixel format rather than guessing badly", () => {
    // ffprobe omits these for some containers; absence must not force a re-encode.
    const decision = decide(
      probe({ video: video({ profile: null, pixelFormat: null }) }),
      { preset: "balanced" },
    );
    assert.equal(decision.mode, "copy");
  });
});

describe("partial path: keep the video, fix the audio", () => {
  // The case worth having a dedicated mode for: re-encoding the video here would
  // be minutes of CPU to fix a two-second audio track.
  it("re-encodes Opus audio without touching the video", () => {
    const decision = decide(probe({ audio: audio({ codec: "opus" }) }), { preset: "balanced" });
    assert.equal(decision.mode, "copy-video-transcode-audio");
    assert.deepEqual(decision.ladder, []);
    assert.match(decision.reasons.join(" "), /opus/i);
  });

  it("does the same for Vorbis", () => {
    const decision = decide(probe({ audio: audio({ codec: "vorbis" }) }), { preset: "balanced" });
    assert.equal(decision.mode, "copy-video-transcode-audio");
  });
});

describe("transcode path", () => {
  it("re-encodes HEVC, which most browsers cannot play", () => {
    const decision = decide(probe({ video: video({ codec: "hevc", profile: "Main" }) }), {
      preset: "balanced",
    });
    assert.equal(decision.mode, "transcode");
    assert.match(decision.reasons.join(" "), /hevc/i);
  });

  it("re-encodes 10-bit H.264", () => {
    const decision = decide(probe({ video: video({ pixelFormat: "yuv420p10le" }) }), {
      preset: "balanced",
    });
    assert.equal(decision.mode, "transcode");
    assert.match(decision.reasons.join(" "), /10-bit|4:2:2/i);
  });

  it("re-encodes High 10 profile", () => {
    const decision = decide(probe({ video: video({ profile: "High 10" }) }), {
      preset: "balanced",
    });
    assert.equal(decision.mode, "transcode");
  });

  it("re-encodes 4:4:4 chroma", () => {
    const decision = decide(probe({ video: video({ profile: "High 4:4:4 Predictive" }) }), {
      preset: "balanced",
    });
    assert.equal(decision.mode, "transcode");
  });

  it("downscales a 4K upload and uses the balanced ladder", () => {
    const decision = decide(
      probe({
        video: video({ width: 3840, height: 2160, bitrateBps: 40_000_000 }),
        bitrateBps: 40_000_000,
      }),
      { preset: "balanced" },
    );
    assert.equal(decision.mode, "transcode");
    assert.equal(decision.downscaling, true);
    assert.deepEqual(
      decision.ladder.map((rung) => rung.name),
      ["720p", "480p"],
    );
  });

  it("re-encodes a wastefully encoded file even when the codec is fine", () => {
    // 20 Mbps for 1080p H.264 is wasteful; serving it unchanged would make the
    // site slow for every visitor forever.
    const decision = decide(
      probe({ video: video({ bitrateBps: 20_000_000 }), bitrateBps: 20_500_000 }),
      { preset: "balanced" },
    );
    assert.equal(decision.mode, "transcode");
    assert.match(decision.reasons.join(" "), /bitrate/i);
  });

  it("reports no video stream as undecidable-but-transcodable rather than crashing", () => {
    const decision = decide(probe({ video: null, audio: audio() }), { preset: "balanced" });
    assert.equal(decision.mode, "transcode");
    assert.deepEqual(decision.ladder, []);
  });
});

describe("ladder fitting", () => {
  it("never upscales: a 720p source gets no 1080p rung", () => {
    const decision = decide(
      probe({ video: video({ width: 1280, height: 720, codec: "hevc", bitrateBps: 2_000_000 }) }),
      { preset: "quality" },
    );
    assert.deepEqual(
      decision.ladder.map((rung) => rung.name),
      ["720p", "480p"],
    );
  });

  it("keeps one rung when the source is smaller than every rung", () => {
    const decision = decide(
      probe({ video: video({ width: 640, height: 360, codec: "hevc", bitrateBps: 500_000 }) }),
      { preset: "quality" },
    );
    assert.equal(decision.ladder.length, 1);
    assert.equal(decision.ladder[0]!.name, "480p");
  });

  it("uses the vertical ladder for reels", () => {
    const decision = decide(
      probe({
        video: video({ width: 1080, height: 1920, codec: "hevc", bitrateBps: 4_000_000 }),
      }),
      { preset: "balanced", isReel: true },
    );
    assert.equal(decision.mode, "transcode");
    assert.deepEqual(
      decision.ladder.map((rung) => rung.name),
      ["720x1280", "540x960"],
    );
  });
});

describe("remux-first preset", () => {
  it("copies when it can", () => {
    const decision = decide(probe(), { preset: "remux-first" });
    assert.equal(decision.mode, "copy");
    assert.deepEqual(decision.ladder, []);
  });

  it("still produces a single playable rung when encoding is unavoidable", () => {
    // "Never encode" cannot mean "produce nothing": an unplayable file is worse
    // than a slow one.
    const decision = decide(probe({ video: video({ codec: "hevc" }) }), {
      preset: "remux-first",
    });
    assert.equal(decision.mode, "transcode");
    assert.equal(decision.ladder.length, 1);
    assert.equal(decision.ladder[0]!.name, "720p");
  });
});

describe("low-power preset", () => {
  it("produces exactly one 720p rendition", () => {
    const decision = decide(
      probe({ video: video({ codec: "hevc", width: 3840, height: 2160 }) }),
      { preset: "low-power" },
    );
    assert.deepEqual(
      decision.ladder.map((rung) => rung.name),
      ["720p"],
    );
  });
});

describe("reasons are always populated", () => {
  it("explains every decision, so the admin UI never shows a bare mode", () => {
    const presets = ["remux-first", "low-power", "balanced", "quality"] as const;
    const codecs = [
      video(),
      video({ codec: "hevc" }),
      video({ codec: "vp9", profile: null, pixelFormat: null }),
      video({ codec: "mpeg4", profile: null, pixelFormat: null, bitrateBps: 1_000_000 }),
    ];
    for (const preset of presets) {
      for (const v of codecs) {
        const decision = decide(probe({ video: v }), { preset });
        assert.ok(decision.reasons.length > 0, `${preset} / ${v.codec} produced no reason`);
      }
    }
  });
});
