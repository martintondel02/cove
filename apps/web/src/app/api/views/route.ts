/**
 * View counting.
 *
 * Deliberately small and deliberately private:
 *
 *  • **No raw IP is ever stored.** A first-party session id is issued as a cookie
 *    and only its salted hash reaches the database, so the table cannot be turned
 *    back into a list of visitors.
 *  • **No third-party analytics**, no scripts, no pixel. The owner sees aggregate
 *    numbers and nothing else.
 *  • Views are only counted for posts that are actually published and not private,
 *    so the numbers cannot be inflated by probing slugs.
 */
import { createHash, randomBytes } from "node:crypto";

import { findViewablePostId, getDb, viewEvents } from "@cove/db";

import { getEnvState } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COOKIE_NAME = "cove_vid";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function sessionHash(sessionId: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${sessionId}`).digest("hex");
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const envState = getEnvState();
  if (!envState.ok) {
    return Response.json({ error: "Not configured." }, { status: 503 });
  }

  let body: { slug?: unknown; seconds?: unknown; quality?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(null, { status: 204 });
  }

  const slug = typeof body.slug === "string" ? body.slug : "";
  if (slug.length === 0) return new Response(null, { status: 204 });

  const seconds = typeof body.seconds === "number" && Number.isFinite(body.seconds)
    ? Math.max(0, Math.min(86_400, Math.round(body.seconds)))
    : 0;
  const quality = typeof body.quality === "string" ? body.quality.slice(0, 32) : null;

  // Issue a session id if the visitor does not have one. Same-site and not readable
  // by script, since nothing on the client needs to read it back.
  const existing = readCookie(request, COOKIE_NAME);
  const sessionId = existing ?? randomBytes(16).toString("hex");
  const headers = new Headers({ "cache-control": "no-store" });
  if (!existing) {
    headers.append(
      "set-cookie",
      `${COOKIE_NAME}=${sessionId}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`,
    );
  }

  try {
    const db = getDb();
    const postId = await findViewablePostId(slug);
    // Unknown or not-yet-published slug: accept silently. A 404 here would let
    // anyone enumerate which slugs exist.
    if (!postId) return new Response(null, { status: 204, headers });

    await db.insert(viewEvents).values({
      postId,
      sessionHash: sessionHash(sessionId, envState.env.secretKey),
      secondsWatched: seconds,
      quality,
    });
  } catch {
    // Analytics must never break playback.
    return new Response(null, { status: 204, headers });
  }

  return new Response(null, { status: 204, headers });
}
