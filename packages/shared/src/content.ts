/**
 * Content kinds. Three products — long video, livestreams, and
 * photos/reels — are modelled as one `post` row with one `kind`, so the home
 * feed is a single ordered query instead of a UNION across three tables.
 * See docs/PLAN.md §1.
 */
export const POST_KINDS = ["video", "live", "photo", "reel", "album"] as const;
export type PostKind = (typeof POST_KINDS)[number];

export function isPostKind(value: unknown): value is PostKind {
  return typeof value === "string" && (POST_KINDS as readonly string[]).includes(value);
}

/** Aspect ratios each kind renders at in the feed. */
export const KIND_ASPECT: Record<PostKind, "16:9" | "4:5" | "9:16"> = {
  video: "16:9",
  live: "16:9",
  photo: "4:5",
  reel: "9:16",
  album: "4:5",
};

/** Media roles a post's assets can take. */
export const MEDIA_ROLES = [
  "source",
  "poster",
  "thumb",
  "hls",
  "sprite",
  "photo",
  "avatar",
  "caption",
] as const;
export type MediaRole = (typeof MEDIA_ROLES)[number];

