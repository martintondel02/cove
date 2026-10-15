/**
 * The remux-or-transcode decision.
 *
 * This is the most valuable logic in the media pipeline, and the least obvious.
 * Re-encoding is the single most expensive thing Cove does — minutes to hours of
 * CPU per upload — and it is usually unnecessary: most phone and camera files are
 * already H.264 + AAC, which every browser can play once remuxed into the right
 * container. So the default answer is "copy the bytes" and the pipeline only
 * decodes when it has a concrete reason.
 *
 * Consequences of getting this wrong in either direction:
 *   • Too eager to transcode → a Pi-class box becomes unusable after one upload.
 *   • Too eager to copy     → videos that silently fail to play on half of
 *                             visitors' devices, which is worse.
 *
 * The rules below are therefore conservative about *playability* and aggressive
 * about *avoiding work*.
 */
import type { PowerPreset } from "@cove/shared";

import {
  PRESET_LADDERS,
  fitLadderToSource,
  orientationOf,
  referenceRung,
  singleFallbackRendition,
  verticalLadder,
} from "./ladder.ts";
import type { Decision, ProbeResult, Rendition } from "./types.ts";

/** Codecs every current browser plays inside HLS/fMP4. */
const PLAYABLE_VIDEO_CODECS = new Set(["h264"]);

/** H.264 profiles that imply 8-bit 4:2:0. Anything else needs a re-encode. */
const PLAYABLE_H264_PROFILES = new Set(["baseline", "constrained baseline", "main", "high"]);

/** Pixel formats that mean 8-bit 4:2:0. */
const PLAYABLE_PIXEL_FORMATS = new Set(["yuv420p", "yuvj420p"]);

/** Audio codecs that work in fMP4 across browsers. Opus is deliberately absent. */
const PLAYABLE_AUDIO_CODECS = new Set(["aac"]);

export interface DecideOptions {
  readonly preset: PowerPreset;
  /** Vertical short-form: uses the 9:16 ladder and shorter segments. */
  readonly isReel?: boolean;
  /**
   * The largest frame Cove is willing to serve without re-encoding. Defaults to
   * 1080 landscape / 1920 portrait. Anything taller is downscaled.
   *
   * This is deliberately separate from a preset's ladder: the ladder decides what
   * a re-encode targets, while this decides when one is needed at all.
   */
  readonly maxServeHeight?: number;
  /**
   * Ratio of source bitrate to the top rung above which the file is considered
   * wastefully encoded and worth re-encoding. 2× keeps a 1080p file under
   * ~10 Mbps as "fine", which covers normal camera output.
   */
  readonly bitrateRatioTolerance?: number;
}

/** Normalise ffprobe's codec names into the ones we reason about. */
function normalizeVideoCodec(codec: string): string {
  const c = codec.toLowerCase();
  if (c === "avc1" || c === "avc3" || c === "h264") return "h264";
  if (c === "hev1" || c === "hvc1" || c === "hevc" || c === "h265") return "hevc";
  return c;
}

function normalizeAudioCodec(codec: string): string {
  const c = codec.toLowerCase();
  if (c === "mp4a" || c === "aac") return "aac";
  if (c === "opus") return "opus";
  if (c === "vorbis") return "vorbis";
  return c;
}

/**
 * Choose what the pipeline should do with this file.
 *
 * Returns a `Decision` describing the mode, the ladder, and *why* — the reasons
 * are surfaced in the admin UI, because "why is this taking 40 minutes" is the
 * question an operator will actually ask.
 */
export function decide(probe: ProbeResult, options: DecideOptions): Decision {
  const reasons: string[] = [];
  const tolerance = options.bitrateRatioTolerance ?? 2;

  if (!probe.video) {
    return {
      mode: "transcode",
      reasons: ["The file has no video stream."],
      ladder: [],
      downscaling: false,
    };
  }

  const video = probe.video;
  const orientation = orientationOf(video.width, video.height);

  // The ladder this preset is willing to produce, narrowed to the source size.
  const presetLadder = options.isReel
    ? fitLadderToSource(verticalLadder(), video.height, "portrait")
    : fitLadderToSource(PRESET_LADDERS[options.preset], video.height, orientation);

  const canEncode = presetLadder.length > 0;

  /**
   * The rungs to use *if* a re-encode happens.
   *
   * For `remux-first` this is a single cheap fallback rung — but it is used only
   * when something else has already forced an encode. It must never itself be the
   * reason for one, or the preset silently stops meaning "never encode": an
   * earlier version compared the source against this fallback rung, concluded a
   * 1080p file was "too big for 720p", and transcoded everything.
   */
  const encodeLadder: readonly Rendition[] = canEncode
    ? presetLadder
    : [singleFallbackRendition()];

  // ── 1. Video codec ────────────────────────────────────────────────────────
  const videoCodec = normalizeVideoCodec(video.codec);
  const codecPlayable = PLAYABLE_VIDEO_CODECS.has(videoCodec);
  if (!codecPlayable) {
    reasons.push(
      `Video codec "${video.codec}" is not playable in all browsers; re-encoding to H.264.`,
    );
  }

  // ── 2. H.264 profile and bit depth ────────────────────────────────────────
  // 10-bit and 4:2:2/4:4:4 H.264 decode poorly or not at all in many browsers.
  let profilePlayable = true;
  if (codecPlayable) {
    const profile = (video.profile ?? "").toLowerCase();
    if (profile && !PLAYABLE_H264_PROFILES.has(profile)) {
      profilePlayable = false;
      reasons.push(`H.264 profile "${video.profile}" is not universally playable.`);
    }
    const pixFmt = (video.pixelFormat ?? "").toLowerCase();
    if (pixFmt && !PLAYABLE_PIXEL_FORMATS.has(pixFmt)) {
      profilePlayable = false;
      reasons.push(`Pixel format "${video.pixelFormat}" implies 10-bit or 4:2:2, which many devices cannot decode.`);
    }
  }

  // ── 3. Resolution ──────────────────────────────────────────────────────────
  // Portrait rungs declare height as the long edge (1920/1280/960), so compare on
  // the long edge for portrait and on height otherwise.
  const sourceLongEdge = Math.max(video.width, video.height);
  const sourceComparable = orientation === "portrait" ? sourceLongEdge : video.height;

  /**
   * The largest frame we are willing to *serve*, as opposed to what we would
   * choose to encode if we had to.
   *
   * This distinction is the whole point. A preset's ladder is what a re-encode
   * targets; it must not by itself demand one. An earlier version capped serving
   * at the `balanced` ladder's 720p top rung, so every already-perfect 1080p phone
   * video was decoded and shrunk — losing quality, burning CPU, and inverting the
   * point of the remux path.
   */
  const maxServeHeight = options.maxServeHeight ?? (orientation === "portrait" ? 1920 : 1080);

  let downscaling = false;
  const mustTranscodeForSize = sourceComparable > maxServeHeight;
  if (mustTranscodeForSize) {
    downscaling = true;
    reasons.push(
      `${video.width}×${video.height} is larger than the ${maxServeHeight}px ceiling Cove serves; downscaling to the ladder.`,
    );
  }

  // ── 4. Wasteful bitrate ────────────────────────────────────────────────────
  // Judged against a reference for the file's *own* resolution, so a normal 1080p
  // file is not accused of waste just because a low preset caps lower.
  let wastefulBitrate = false;
  if (codecPlayable && profilePlayable && !mustTranscodeForSize && video.bitrateBps) {
    const reference = referenceRung(sourceComparable, orientation);
    const threshold = reference.videoBitrateKbps * 1000 * tolerance;
    if (video.bitrateBps > threshold) {
      wastefulBitrate = true;
      reasons.push(
        `Bitrate ${Math.round(video.bitrateBps / 1000)} kbps is over ${tolerance}× what ${reference.name} needs; re-encoding to save bandwidth.`,
      );
    }
  }

  // ── 5. Audio ───────────────────────────────────────────────────────────────
  let audioNeedsWork = false;
  if (probe.audio) {
    const audioCodec = normalizeAudioCodec(probe.audio.codec);
    if (!PLAYABLE_AUDIO_CODECS.has(audioCodec)) {
      audioNeedsWork = true;
      reasons.push(
        `Audio codec "${probe.audio.codec}" does not play reliably in fMP4; re-encoding audio to AAC.`,
      );
    }
  }

  // ── The decision ──────────────────────────────────────────────────────────
  const mustTranscodeVideo = !codecPlayable || !profilePlayable || mustTranscodeForSize || wastefulBitrate;

  if (mustTranscodeVideo) {
    return {
      mode: "transcode",
      reasons,
      ladder: encodeLadder,
      downscaling,
    };
  }

  if (audioNeedsWork) {
    // The cheap win: keep the expensive video bytes, re-encode only the audio.
    return {
      mode: "copy-video-transcode-audio",
      reasons,
      ladder: [],
      downscaling: false,
    };
  }

  return {
    mode: "copy",
    reasons:
      reasons.length > 0
        ? reasons
        : ["Already H.264 + AAC and within the size budget — remuxing without re-encoding."],
    ladder: [],
    downscaling: false,
  };
}
