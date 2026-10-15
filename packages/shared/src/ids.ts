/**
 * Federation seam #1 — stable, canonical, dereferenceable URIs.
 *
 * A federated identity *is* a URL. Remote servers cache these forever: they
 * appear in followers' timelines, in `inReplyTo` fields, and in every copy of
 * a post that ever reached another instance. That means a URI may be minted
 * exactly once and must never be renumbered, restructured, or reused — which
 * is why URL construction lives in one place, is pure, and is covered by the
 * tests in `ids.test.ts`.
 *
 * Everything federated hangs off the site URL, so changing `COVE_SITE_URL`
 * after a single follower exists is a breaking change, not a config tweak.
 */

/** What kind of thing a URI points at. Used for routing and for AS2 typing. */
export type UriKind = "actor" | "post" | "media" | "collection";

/** Strip any trailing slash so `https://a.co/` and `https://a.co` agree. */
export function normalizeSiteUrl(siteUrl: string): string {
  return siteUrl.trim().replace(/\/+$/, "");
}

/** The domain part of the site URL, e.g. `cove.example.com`. */
export function siteDomain(siteUrl: string): string {
  const normalized = normalizeSiteUrl(siteUrl);
  // URL#host includes the port for non-default ports, which is what we want
  // for LAN installs like http://localhost:3000.
  return new URL(normalized).host;
}

/** The scheme + host, used to build the WebFinger `acct:` subject. */
export function webFingerSubject(siteUrl: string, handle: string): string {
  return `acct:${handle}@${siteDomain(siteUrl)}`;
}

/**
 * The actor's canonical URI. This is the one URL that identifies the person:
 * it serves HTML to browsers and an ActivityStreams `Person` to fediverse
 * servers (see seam #2, content negotiation).
 *
 * `https://cove.example.com/@me`
 */
export function actorUri(siteUrl: string, handle: string): string {
  return `${normalizeSiteUrl(siteUrl)}/@${encodeURIComponent(handle)}`;
}

/** `/@me/inbox` — where remote servers POST activities addressed to us. */
export function actorInboxUri(siteUrl: string, handle: string): string {
  return `${actorUri(siteUrl, handle)}/inbox`;
}

/** `/@me/outbox` — the ordered collection of everything we have published. */
export function actorOutboxUri(siteUrl: string, handle: string): string {
  return `${actorUri(siteUrl, handle)}/outbox`;
}

/** `/@me/followers` — the collection AS2 uses for the "followers-only" audience. */
export function actorFollowersUri(siteUrl: string, handle: string): string {
  return `${actorUri(siteUrl, handle)}/followers`;
}

/**
 * A post's canonical URI. Deliberately short and opaque-ish: `slug` is stable
 * and human-readable, but never derived from the title, so editing a title
 * cannot break a federated link.
 *
 * `https://cove.example.com/p/autumn-north-coast`
 */
export function postUri(siteUrl: string, slug: string): string {
  return `${normalizeSiteUrl(siteUrl)}/p/${encodeURIComponent(slug)}`;
}

/**
 * The shared inbox for the instance. Single-tenant means one actor today, but
 * this exists now so that adding a collaborator later does not change the
 * routing surface that remote servers already know about.
 */
export function sharedInboxUri(siteUrl: string): string {
  return `${normalizeSiteUrl(siteUrl)}/inbox`;
}

/** WebFinger discovery endpoint, required by seam #3. */
export function webFingerUrl(siteUrl: string, handle: string): string {
  const url = new URL("/.well-known/webfinger", normalizeSiteUrl(siteUrl));
  url.searchParams.set("resource", webFingerSubject(siteUrl, handle));
  return url.toString();
}

/**
 * Slugs are part of a permanent URI, so they are intentionally conservative:
 * lowercase ASCII, digits and single hyphens. Anything else is stripped rather
 * than escaped, to avoid percent-encoding in a URL that must never change.
 */
export function slugify(input: string, fallback = "untitled"): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : fallback;
}

/** Reserved path prefixes that a slug must never collide with. */
export const RESERVED_SLUGS: readonly string[] = [
  "p",
  "api",
  "admin",
  "inbox",
  "outbox",
  "followers",
  "following",
  "media",
  "static",
  "well-known",
  "settings",
  "login",
  "setup",
];
