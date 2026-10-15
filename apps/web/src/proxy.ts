/**
 * Federation seam #2, the routing half.
 *
 * The pretty URLs a fediverse server will cache are `/@handle` and `/p/slug`.
 * But `/@handle` cannot be a Next.js route folder: directories prefixed with
 * `@` are reserved for *named slots*, so `app/@[handle]` would be parsed as a
 * parallel route rather than a URL segment.
 *
 * So the public URLs are reserved here and rewritten internally, choosing the
 * target by `Accept`:
 *
 *   GET /@me            Accept: text/html              → /u/me            (a page)
 *   GET /@me            Accept: application/activity+json → /api/as2/actor/me
 *   GET /@me/outbox     Accept: application/activity+json → /api/as2/actor/me/outbox
 *   GET /p/some-slug    Accept: application/activity+json → /api/as2/post/some-slug
 *
 * This is why the canonical URIs in @cove/shared stay clean and permanent while
 * the *implementation* stays idiomatic Next.js: the mapping is one hop, in one
 * file, and the external contract never moves.
 *
 * Next 16 renamed `middleware` to `proxy`. It runs on the Node.js runtime.
 */
import { NextResponse, type NextRequest } from "next/server";

import { prefersActivityStreams } from "@/lib/federation/accept";

/** `/@handle` optionally followed by a federation sub-path. */
const ACTOR_PATH = /^\/@([A-Za-z0-9_]{1,30})((?:\/[a-z]+)?)\/?$/;

/** `/p/slug` — the canonical, permanent URI of a post. */
const POST_PATH = /^\/p\/([^/]+)\/?$/;

/** Sub-paths that exist as federation endpoints on an actor. */
const ACTOR_SUFFIXES = new Set(["", "/outbox", "/followers", "/inbox"]);

export default function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const accept = request.headers.get("accept");

  const actorMatch = ACTOR_PATH.exec(pathname);
  if (actorMatch) {
    const handle = actorMatch[1];
    const suffix = actorMatch[2] ?? "";

    if (handle === undefined) return NextResponse.next();

    // An inbox delivery is a server-to-server POST. Routing it by `Accept` is
    // wrong: remote servers are inconsistent about what they send there, and a
    // delivery that lands on the HTML profile page instead of the inbox handler
    // is a silent, confusing failure. Non-GET requests always go to AS2.
    const isMachineRequest = request.method !== "GET" || prefersActivityStreams(accept);

    if (isMachineRequest) {
      // Unknown sub-paths must 404 rather than being silently rewritten.
      if (!ACTOR_SUFFIXES.has(suffix)) return NextResponse.next();

      const url = request.nextUrl.clone();
      url.pathname = `/api/as2/actor/${handle}${suffix}`;
      return NextResponse.rewrite(url);
    }

    // A browser (or a link preview bot) gets the human profile page.
    const url = request.nextUrl.clone();
    url.pathname = `/u/${handle}`;
    return NextResponse.rewrite(url);
  }

  const postMatch = POST_PATH.exec(pathname);
  if (postMatch && prefersActivityStreams(accept)) {
    const slug = postMatch[1];
    if (slug === undefined) return NextResponse.next();

    const url = request.nextUrl.clone();
    url.pathname = `/api/as2/post/${slug}`;
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  // Run on page routes but skip Next's own static output, so the hot path for
  // assets never touches this code.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
