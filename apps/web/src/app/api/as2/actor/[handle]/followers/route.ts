/**
 * The followers collection.
 *
 * Returns an empty collection: there is no follow-handling until Phase 5, when
 * Fedify takes over this endpoint. It exists now because the actor document
 * references it, and because `unlisted` visibility maps to a followers-only AS2
 * audience — so the URL has to be real and permanent.
 *
 * The `totalItems: 0` here is honest rather than a placeholder: nobody can
 * follow yet, because inbound activities are disabled by design (broadcast-first).
 */
import type { Actor } from "@cove/db";

import { as2Response, buildOrderedCollection } from "@/lib/federation/as2";
import { loadFederationContext } from "@/lib/federation/context";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ handle: string }> },
): Promise<Response> {
  const { handle } = await context.params;
  const lookup = await loadFederationContext(handle);
  if (!lookup.ok) return lookup.response;

  const actor: Actor = lookup.context.actor;

  return as2Response(
    buildOrderedCollection({
      id: actor.followersUri,
      totalItems: 0,
      items: [],
    }),
  );
}
