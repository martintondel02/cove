/**
 * Federation seam #5 — visibility that maps cleanly onto ActivityStreams 2.0.
 *
 * The lesson from the fediverse is that a visibility model which cannot be
 * expressed in AS2 becomes a permanent source of bugs and leaked posts. So the
 * enum is deliberately tiny, and each value has exactly one audience mapping.
 *
 * The rule for the future: never add a visibility value that cannot be
 * expressed here. If a feature needs one, that is a signal to reconsider the
 * feature rather than to widen the enum.
 */

export const VISIBILITIES = ["public", "unlisted", "private"] as const;

export type Visibility = (typeof VISIBILITIES)[number];

/**
 * AS2's magic "everyone, including anonymous" audience. This exact IRI is what
 * makes a post discoverable in Mastodon's public timelines.
 */
export const AS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

export interface Audience {
  /** Primary recipients — the `to` field. */
  readonly to: readonly string[];
  /** Secondary recipients — the `cc` field. */
  readonly cc: readonly string[];
}

/**
 * Translate a visibility into AS2 `to`/`cc` audiences.
 *
 * Returns `null` for content that must never federate, so callers are forced to
 * handle that case explicitly rather than accidentally publishing it.
 *
 * The `to`/`cc` split is not cosmetic: Mastodon decides whether a post appears
 * in public timelines based on whether `AS_PUBLIC` is in `to` (yes) or only in
 * `cc` (no). So `public` puts it in `to`, and `unlisted` demotes it to `cc` —
 * which is precisely the "anyone with the link, but don't show it around"
 * behaviour.
 */
export function visibilityToAudience(
  visibility: Visibility,
  followersUri: string,
): Audience | null {
  switch (visibility) {
    case "public":
      return { to: [AS_PUBLIC], cc: [followersUri] };
    case "unlisted":
      return { to: [followersUri], cc: [AS_PUBLIC] };
    case "private":
      return null;
  }
}

/** Whether this post should be delivered to remote inboxes at all. */
export function isFederated(visibility: Visibility): boolean {
  return visibility !== "private";
}

/** Whether this post may appear in the site's own public feed. */
export function isPubliclyListed(visibility: Visibility): boolean {
  return visibility === "public";
}

export function isVisibility(value: unknown): value is Visibility {
  return typeof value === "string" && (VISIBILITIES as readonly string[]).includes(value);
}
