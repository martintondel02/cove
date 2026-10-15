/**
 * Post queries used by the federation endpoints.
 *
 * Kept in the database package rather than in the route handlers so the
 * visibility filter lives next to the schema it protects: a `private` post must
 * never appear in a collection, and that rule should not be re-implemented (and
 * eventually forgotten) in each route.
 */
import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";

import { getDb, type Database } from "./client";
import { posts, type Post } from "./schema";

/**
 * Posts that may be announced to the fediverse.
 *
 * Excludes: unpublished drafts, tombstoned deletes, and anything `private`.
 * `unlisted` is included on purpose — unlisted means "don't list it", not
 * "don't federate it", which is exactly the AS2 `cc`-only audience.
 */
export async function listFederatedPosts(
  actorId: string,
  limit = 20,
  db: Database = getDb(),
): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(
      and(
        eq(posts.authorId, actorId),
        isNull(posts.deletedAt),
        isNotNull(posts.publishedAt),
        ne(posts.visibility, "private"),
      ),
    )
    .orderBy(desc(posts.publishedAt))
    .limit(limit);
}

/** A single post by its permanent slug, including tombstoned ones. */
export async function getPostBySlug(
  slug: string,
  db: Database = getDb(),
): Promise<Post | undefined> {
  const rows = await db.select().from(posts).where(eq(posts.slug, slug)).limit(1);
  return rows[0];
}

/** Count of federated posts, for the outbox `totalItems`. */
export async function countFederatedPosts(
  actorId: string,
  db: Database = getDb(),
): Promise<number> {
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.authorId, actorId),
        isNull(posts.deletedAt),
        isNotNull(posts.publishedAt),
        ne(posts.visibility, "private"),
      ),
    );
  return rows.length;
}
