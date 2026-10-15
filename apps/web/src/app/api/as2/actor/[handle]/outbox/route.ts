/**
 * The outbox: everything this actor has published, newest first.
 *
 * Phase 0 has no publishing pipeline, so this legitimately returns an empty
 * collection — but it queries for real, which means it starts returning items
 * the moment Phase 1 creates the first post. The endpoint exists now so the
 * `outbox` field in the actor document does not 404 and the identity is
 * complete.
 */
import { countFederatedPosts, listFederatedPosts } from "@cove/db";

import { as2Response, buildOrderedCollection } from "@/lib/federation/as2";
import { loadFederationContext } from "@/lib/federation/context";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export async function GET(
  _request: Request,
  context: { params: Promise<{ handle: string }> },
): Promise<Response> {
  const { handle } = await context.params;
  const lookup = await loadFederationContext(handle);
  if (!lookup.ok) return lookup.response;

  const { actor } = lookup.context;

  try {
    const [items, total] = await Promise.all([
      listFederatedPosts(actor.id, PAGE_SIZE),
      countFederatedPosts(actor.id),
    ]);

    return as2Response(
      buildOrderedCollection({
        id: actor.outboxUri,
        totalItems: total,
        // Items are referenced by id rather than inlined: remote servers fetch
        // the object from its own URL, which keeps this payload small and means
        // the object's canonical URI is the one they cache.
        items: items.map((post) => post.uri),
      }),
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: "The database is unavailable.", detail: (error as Error).message }),
      { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  }
}
