/**
 * Encoding ladders, and the power presets that choose between them.
 *
 * The presets exist because the same software has to run on a Raspberry Pi and
 * on a workstation, and the operator should make that trade-off knowingly at
 * install time rather than discovering it when an upload pins every core for an
 * hour. See docs/PLAN.md §7.1.
 *
 * Bitrates follow the research brief: roughly YouTube's guidance, capped below
 * Apple's own H.264 table (1080p 6000k, 720p 3000k, 540p 2000k), because a
 * personal site does not need the headroom a commercial encoder budget buys.
 */
import type { PowerPreset } from "@cove/shared";

import type { Rendition } from "./types.ts";

/** 16:9 rungs, largest first. */
export const RENDITIONS_16_9: Record<string, Rendition> = {
  "1080p": {
    name: "1080p",
    width: 1920,
    height: 1080,
    videoBitrateKbps: 5000,
    maxrateKbps: 5350,
    bufsizeKbps: 7500,
    audioBitrateKbps: 128,
  },
  "720p": {
    name: "720p",
    width: 1280,
    height: 720,
    videoBitrateKbps: 2800,
    maxrateKbps: 3000,
    bufsizeKbps: 4200,
    audioBitrateKbps: 128,
  },
  "480p": {
    name: "480p",
    width: 854,
    height: 480,
    videoBitrateKbps: 1200,
    maxrateKbps: 1280,
    bufsizeKbps: 1800,
    audioBitrateKbps: 96,
  },
};

/**
 * 9:16 rungs for reels.
 *
 * No 1080p rung: vertical video is watched on phones, where 720p is
 * indistinguishable and the extra bytes make the feed feel slow to start.
 */
export const RENDITIONS_9_16: Record<string, Rendition> = {
  "1080x1920": {
    name: "1080x1920",
    width: 1080,
    height: 1920,
    videoBitrateKbps: 4500,
    maxrateKbps: 4800,
    bufsizeKbps: 6750,
    audioBitrateKbps: 128,
  },
  "720x1280": {
    name: "720x1280",
    width: 720,
    height: 1280,
    videoBitrateKbps: 2500,
    maxrateKbps: 2700,
    bufsizeKbps: 3750,
    audioBitrateKbps: 128,
  },
  "540x960": {
    name: "540x960",
    width: 540,
    height: 960,
    videoBitrateKbps: 1100,
    maxrateKbps: 1200,
    bufsizeKbps: 1650,
    audioBitrateKbps: 96,
  },
};

/**
 * The rungs each preset is allowed to produce.
 *
 * `remux-first` intentionally has an empty ladder: it exists for hardware that
 * genuinely cannot encode, and the pipeline will still fall back to a single
 * 720p rung when a file is unplayable as-is (see `singleFallbackRendition`).
 */
export const PRESET_LADDERS: Record<PowerPreset, readonly Rendition[]> = {
  "remux-first": [],
  "low-power": [RENDITIONS_16_9["720p"]!],
  balanced: [RENDITIONS_16_9["720p"]!, RENDITIONS_16_9["480p"]!],
  quality: [
    RENDITIONS_16_9["1080p"]!,
    RENDITIONS_16_9["720p"]!,
    RENDITIONS_16_9["480p"]!,
  ],
};

/** A vertical rung to use when a reel must be re-encoded. */
export function verticalLadder(): readonly Rendition[] {
  return [RENDITIONS_9_16["720x1280"]!, RENDITIONS_9_16["540x960"]!];
}

/** The one rung used when `remux-first` is forced to encode after all. */
export function singleFallbackRendition(): Rendition {
  return RENDITIONS_16_9["720p"]!;
}

/**
 * The rung that best represents "a sensibly encoded file at this size".
 *
 * Used to judge whether an input is wastefully encoded, so it must be independent
 * of the preset: the question is "is this file bigger than it needs to be for its
 * resolution?", not "is it bigger than the highest rung this preset will produce?".
 * Conflating the two made every 1080p file look wasteful under the 720p-capped
 * `balanced` preset.
 */
export function referenceRung(height: number, orientation: Orientation): Rendition {
  const table = orientation === "portrait" ? RENDITIONS_9_16 : RENDITIONS_16_9;
  const rungs = Object.values(table);
  const atOrBelow = rungs.filter((rung) => rung.height <= height);
  if (atOrBelow.length > 0) {
    return atOrBelow.reduce((a, b) => (a.height >= b.height ? a : b));
  }
  // Source is smaller than every reference rung: use the smallest.
  return rungs.reduce((a, b) => (a.height <= b.height ? a : b));
}

/** Aspect ratio classification, which decides which ladder applies. */
export type Orientation = "landscape" | "portrait" | "square";

export function orientationOf(width: number, height: number): Orientation {
  if (width === height) return "square";
  return height > width ? "portrait" : "landscape";
}

/**
 * Drop rungs that would upscale the source.
 *
 * Upscaling costs CPU and produces a bigger file that looks no better, so a
 * 720p upload must not generate a 1080p rung. Returns at least one rung unless
 * the input ladder was empty.
 */
export function fitLadderToSource(
  ladder: readonly Rendition[],
  sourceHeight: number,
  orientation: Orientation,
): readonly Rendition[] {
  if (ladder.length === 0) return [];

  // For portrait video the meaningful dimension is still the *height* field as
  // declared in the rung (1920 for 1080x1920), which is what we compare against.
  const fitted = ladder.filter((rung) => rung.height <= sourceHeight);
  if (fitted.length > 0) return fitted;

  // Source is smaller than every rung: keep the smallest one rather than
  // producing nothing, which still normalises the file into something playable.
  const smallest = ladder.reduce((a, b) => (a.height <= b.height ? a : b));
  void orientation;
  return [smallest];
}
