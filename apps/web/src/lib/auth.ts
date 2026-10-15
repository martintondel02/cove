/**
 * Publishing auth — a deliberate stopgap.
 *
 * Cove's real answer is passkeys, which arrive with the setup wizard in Phase 2.
 * Until then, the publishing endpoints require a bearer token from
 * `COVE_ADMIN_TOKEN`, and **an unset token disables publishing entirely rather
 * than leaving it open**. A self-hosted "create a post" endpoint reachable by
 * anyone on the internet is a genuinely nasty surprise, and the safe default has
 * to be the one that happens when somebody forgets to configure something.
 */
import { timingSafeEqual } from "node:crypto";

import { getEnvState } from "./env";

export type AdminCheck = { readonly ok: true } | { readonly ok: false; readonly response: Response };

/** Minimum length that is worth calling a secret. */
const MIN_TOKEN_LENGTH = 16;

function unauthorized(message: string, hint: string, status = 401): Response {
  return Response.json({ error: message, hint }, { status, headers: { "cache-control": "no-store" } });
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, so compare lengths first — that
  // leaks length, which is acceptable; it does not leak content.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Pull a bearer token out of the Authorization header or an `x-cove-token` header. */
function extractToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  const custom = request.headers.get("x-cove-token");
  return custom ? custom.trim() : null;
}

export function requireAdmin(request: Request): AdminCheck {
  const envState = getEnvState();
  if (!envState.ok) {
    return {
      ok: false,
      response: unauthorized("Cove is not configured yet.", envState.error, 503),
    };
  }

  const expected = envState.env.adminToken;

  if (expected.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      response: unauthorized(
        "Publishing is disabled because no admin token is set.",
        "Set COVE_ADMIN_TOKEN in .env (at least 16 characters) and restart. `./setup.sh` generates one.",
        403,
      ),
    };
  }

  const provided = extractToken(request);
  if (!provided || !safeEqual(provided, expected)) {
    return {
      ok: false,
      response: unauthorized(
        "That publishing token is not valid.",
        "Send it as `Authorization: Bearer <token>`, or set X-Cove-Token.",
      ),
    };
  }

  return { ok: true };
}
