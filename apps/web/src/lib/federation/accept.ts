/**
 * Federation seam #2 — content negotiation.
 *
 * The same URL must serve a human-readable page to a browser and an
 * ActivityStreams object to a fediverse server. This module is pure string
 * logic with no dependencies, because it also runs inside Next's `proxy`
 * (which executes on the Node runtime but should stay cheap).
 *
 * Kept separate from the routing so it can be unit-tested directly.
 */

export const ACTIVITY_JSON = "application/activity+json";
export const LD_JSON = "application/ld+json";
export const AS2_PROFILE = "https://www.w3.org/ns/activitystreams";

/** The content type we answer fediverse requests with. */
export const AS2_CONTENT_TYPE = `${ACTIVITY_JSON}; profile="${AS2_PROFILE}"`;

interface AcceptEntry {
  readonly type: string;
  readonly q: number;
}

/** Minimal Accept parser — enough for `type;q=0.9,type2` without a dependency. */
function parseAccept(header: string | null): AcceptEntry[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part) => {
      const [rawType = "", ...params] = part.split(";");
      let q = 1;
      for (const param of params) {
        const [key, value] = param.split("=").map((s) => s.trim());
        if (key === "q" && value !== undefined) {
          const parsed = Number.parseFloat(value);
          if (!Number.isNaN(parsed)) q = parsed;
        }
      }
      return { type: rawType.trim().toLowerCase(), q };
    })
    .filter((entry) => entry.type.length > 0)
    .sort((a, b) => b.q - a.q);
}

/**
 * Does this request want ActivityStreams rather than HTML?
 *
 * Deliberately strict: we only switch to AS2 when the client explicitly asks
 * for it, or when it sends a wildcard/absent Accept together with the
 * conventional `Accept: application/*` from a bot. Browsers must never be
 * served JSON by accident, and an explicit `text/html` always wins.
 */
export function prefersActivityStreams(acceptHeader: string | null): boolean {
  const entries = parseAccept(acceptHeader);
  if (entries.length === 0) return false;

  for (const { type, q } of entries) {
    if (q === 0) continue;

    // An explicit request for HTML outranks everything else.
    if (type === "text/html" || type === "application/xhtml+xml") return false;

    if (type === ACTIVITY_JSON || type === LD_JSON) return true;

    // `application/ld+json; profile="...activitystreams"` arrives as the bare
    // type after our simplistic parsing, so the profile is checked separately
    // by the caller when it needs to be certain.
    if (type === "application/*+json") return true;
  }
  return false;
}

/** Does the header mention the AS2 profile explicitly? */
export function declaresAs2Profile(acceptHeader: string | null): boolean {
  return typeof acceptHeader === "string" && acceptHeader.includes(AS2_PROFILE);
}

/**
 * Headers for a content-negotiated response.
 *
 * `Vary: Accept` is not optional here: without it a shared cache can serve the
 * JSON rendering to a browser, or the HTML to Mastodon.
 */
export function negotiatedHeaders(contentType: string): HeadersInit {
  return {
    "content-type": contentType,
    vary: "Accept",
  };
}
