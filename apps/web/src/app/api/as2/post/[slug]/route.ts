/**
 * A single post, as the fediverse sees it. Reached at the post's permanent
 * `/p/<slug>` URL when the client asks for ActivityStreams.
 *
 * Federation seam #4 lives here: a tombstoned post answers **410 Gone** with an
 * AS2 `Tombstone`, not 404. The distinction matters — 404 tells a remote server
 * "I never had this", whereas 410 tells it "I had this and it is deliberately
 * gone", which is what stops a stale copy being served from someone's cache
 * forever.
 */
import { getPostBySlug } from "@cove/db";

import { as2Response, buildPostObject, buildTombstone } from "@/lib/federation/as2";
import { loadFederationContext } from "@/lib/federation/context";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;

  // The handle is not in this URL, so resolve the configured actor first — a
  // post's `attributedTo` and audience both depend on it.
  const envHandle = process.env.COVE_HANDLE;
  if (!envHandle) {
    return Response.json(
      { error: "This instance is not configured yet." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const lookup = await loadFederationContext(envHandle);
  if (!lookup.ok) return lookup.response;

  const { actor } = lookup.context;

  try {
    const post = await getPostBySlug(slug);

    if (!post) {
      return Response.json(
        { error: `No post with slug "${slug}".` },
        { status: 404, headers: { "content-type": "application/activity+json", vary: "Accept" } },
      );
    }

    // Tombstone first: a deleted post is still a known object.
    if (post.deletedAt) {
      return as2Response(buildTombstone(post.uri, post.deletedAt), { status: 410 });
    }

    // Authorship check — a slug belonging to a collaborator should not be served
    // as the owner's object.
    if (post.authorId !== actor.id) {
      return Response.json(
        { error: "That post belongs to a different actor on this instance." },
        { status: 404, headers: { "content-type": "application/activity+json", vary: "Accept" } },
      );
    }

    const object = buildPostObject(post, {
      siteUrl: lookup.context.env.siteUrl,
      actorUri: actor.uri,
      followersUri: actor.followersUri,
      // Phase 1 supplies `posterUrl` (and `durationSeconds` for video) from the
      // post's poster media asset once the media pipeline exists.
    });

    // `null` means "must not federate" (private). Answer the same way we would
    // for a post that does not exist, so private posts cannot be enumerated.
    if (object === null) {
      return Response.json(
        { error: `No post with slug "${slug}".` },
        { status: 404, headers: { "content-type": "application/activity+json", vary: "Accept" } },
      );
    }

    return as2Response(object);
  } catch (error) {
    return Response.json(
      { error: "The database is unavailable.", detail: (error as Error).message },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
