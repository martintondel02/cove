/**
 * Federation seam #3 — WebFinger (RFC 7033).
 *
 * This is how the fediverse turns `@me@cove.example.com` into an actor URL.
 * Without it, nobody can find or follow the instance, no matter how correct the
 * actor document is.
 *
 * Implemented now, in Phase 0, because the *endpoint path* is part of the
 * permanent external contract — and because having it work makes the identity
 * real rather than aspirational.
 */
import { siteDomain } from "@cove/shared";
import { getActorByHandle } from "@cove/db";

import { getEnvState } from "@/lib/env";
import { buildWebFingerResponse } from "@/lib/federation/as2";

export const dynamic = "force-dynamic";

const JRD_CONTENT_TYPE = "application/jrd+json";

function jrd(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": JRD_CONTENT_TYPE,
      vary: "Accept",
      "cache-control": "public, max-age=300",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const envState = getEnvState();
  if (!envState.ok) {
    return jrd({ error: "This instance is not configured yet." }, 503);
  }

  const url = new URL(request.url);
  const resource = url.searchParams.get("resource");

  if (!resource) {
    return jrd(
      {
        error: "Missing required `resource` parameter.",
        example: `?resource=acct:${envState.env.handle}@${siteDomain(envState.env.siteUrl)}`,
      },
      400,
    );
  }

  // Accept both `acct:handle@domain` and a bare `handle@domain`, since clients
  // differ in how strictly they follow the spec.
  const match = /^(?:acct:)?([^@]+)@(.+)$/.exec(resource.trim());
  if (!match) {
    return jrd({ error: "`resource` must look like acct:user@domain." }, 400);
  }

  const [, requestedHandle, requestedDomain] = match;
  const expectedDomain = siteDomain(envState.env.siteUrl);

  // A mismatch here means someone is asking this instance about an identity it
  // does not own — answering would be an impersonation vector.
  if (requestedDomain !== expectedDomain) {
    return jrd({ error: `This instance serves ${expectedDomain}, not ${requestedDomain}.` }, 404);
  }

  if (requestedHandle !== envState.env.handle) {
    return jrd({ error: `No such account: ${requestedHandle}` }, 404);
  }

  try {
    const actor = await getActorByHandle(envState.env.handle);
    if (!actor) {
      return jrd(
        {
          error: "The owner account has not been created yet.",
          hint: "The site seeds it on first boot — check the web logs.",
        },
        503,
      );
    }

    return jrd(
      buildWebFingerResponse(actor.handle, actor.uri, expectedDomain),
    );
  } catch (error) {
    return jrd({ error: "Database unavailable.", detail: (error as Error).message }, 503);
  }
}
