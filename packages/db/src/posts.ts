/**
 * Post queries used by the federation endpoints.
 *
 * Kept in the database package rather than in the route handlers so the
 * visibility filter lives next to the schema it protects: a `private` post must
 * never appear in a collection, and that rule should not be re-implemented (and
 * eventually forgotten) in each route.
 */
import { and, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";

import { getDb, type Database } from "./client.ts";
import { mediaAssets, posts, videos, type Post } from "./schema.ts";

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

/** A published video, shaped for the watch page and the library grid. */
export interface PublishedVideo {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: (typeof posts.kind.enumValues)[number];
  readonly body: string | null;
  readonly altText: string | null;
  readonly publishedAt: Date | null;
  readonly visibility: (typeof posts.visibility.enumValues)[number];
  readonly durationMs: number | null;
  readonly masterPlaylist: string | null;
  readonly renditions: readonly unknown[];
  readonly remuxOnly: boolean;
  /** Poster frame path relative to the data root. */
  readonly posterPath: string | null;
  /** Ambient backdrop colour extracted from the video itself. */
  readonly dominantColor: string | null;
  /** Sprite index (a WebVTT document) relative to the data root. */
  readonly spriteIndexPath: string | null;
}

const VISIBLE = and(
  isNull(posts.deletedAt),
  isNotNull(posts.publishedAt),
  ne(posts.visibility, "private"),
);

/**
 * Published videos, newest first.
 *
 * Private posts are excluded here rather than filtered by callers: a `private`
 * post must never be listed, and repeating that rule at each call site is how it
 * eventually gets forgotten.
 */
export async function listPublishedVideos(
  limit = 48,
  db: Database = getDb(),
): Promise<PublishedVideo[]> {
  const rows = await db
    .select({
      id: posts.id,
      slug: posts.slug,
      title: posts.title,
      kind: posts.kind,
      body: posts.body,
      altText: posts.altText,
      publishedAt: posts.publishedAt,
      visibility: posts.visibility,
      masterPlaylist: videos.masterPlaylist,
      renditions: videos.renditions,
      remuxOnly: videos.remuxOnly,
    })
    .from(posts)
    .leftJoin(videos, eq(videos.postId, posts.id))
    .where(VISIBLE)
    .orderBy(desc(posts.publishedAt))
    .limit(limit);

  return attachArtwork(rows, db);
}

/** One published video by its permanent slug, or undefined. */
export async function getPublishedVideoBySlug(
  slug: string,
  db: Database = getDb(),
): Promise<PublishedVideo | undefined> {
  const rows = await db
    .select({
      id: posts.id,
      slug: posts.slug,
      title: posts.title,
      kind: posts.kind,
      body: posts.body,
      altText: posts.altText,
      publishedAt: posts.publishedAt,
      visibility: posts.visibility,
      masterPlaylist: videos.masterPlaylist,
      renditions: videos.renditions,
      remuxOnly: videos.remuxOnly,
    })
    .from(posts)
    .leftJoin(videos, eq(videos.postId, posts.id))
    .where(and(VISIBLE, eq(posts.slug, slug)))
    .limit(1);

  const [withArt] = await attachArtwork(rows, db);
  return withArt;
}

type VideoRow = {
  id: string;
  slug: string;
  title: string;
  kind: (typeof posts.kind.enumValues)[number];
  body: string | null;
  altText: string | null;
  publishedAt: Date | null;
  visibility: (typeof posts.visibility.enumValues)[number];
  masterPlaylist: string | null;
  renditions: unknown[] | null;
  remuxOnly: boolean | null;
};

/** Fetch poster and sprite paths for a set of posts in one query. */
async function attachArtwork(
  rows: VideoRow[],
  db: Database,
): Promise<PublishedVideo[]> {
  if (rows.length === 0) return [];

  const assets = await db
    .select({
      postId: mediaAssets.postId,
      role: mediaAssets.role,
      path: mediaAssets.path,
      mime: mediaAssets.mime,
      dominantColor: mediaAssets.dominantColor,
    })
    .from(mediaAssets)
    .where(
      inArray(
        mediaAssets.postId,
        rows.map((row) => row.id),
      ),
    );

  return rows.map((row) => {
    const mine = assets.filter((asset) => asset.postId === row.id);
    const poster = mine.find((asset) => asset.role === "poster");
    const sprite = mine.find((asset) => asset.role === "sprite" && asset.mime === "text/vtt");
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      kind: row.kind,
      body: row.body,
      altText: row.altText,
      publishedAt: row.publishedAt,
      visibility: row.visibility,
      durationMs: null,
      masterPlaylist: row.masterPlaylist,
      renditions: row.renditions ?? [],
      remuxOnly: row.remuxOnly ?? false,
      posterPath: poster?.path ?? null,
      dominantColor: poster?.dominantColor ?? null,
      spriteIndexPath: sprite?.path ?? null,
    };
  });
}

/* ───────────────────── writes used by the publishing API ───────────────────── */

export interface InsertPostInput {
  readonly authorId: string;
  readonly kind: (typeof posts.kind.enumValues)[number];
  readonly slug: string;
  /** Canonical, permanent URI. Minted once — see @cove/shared/ids. */
  readonly uri: string;
  readonly title: string;
  readonly body?: string | null;
  readonly visibility: (typeof posts.visibility.enumValues)[number];
}

/**
 * Create a post.
 *
 * `published_at` is deliberately left null: a post becomes visible only when the
 * worker has produced media it can actually play, so a half-processed upload can
 * never be listed.
 */
export async function insertPost(
  input: InsertPostInput,
  db: Database = getDb(),
): Promise<{ id: string; slug: string }> {
  const rows = await db
    .insert(posts)
    .values({
      authorId: input.authorId,
      kind: input.kind,
      slug: input.slug,
      uri: input.uri,
      title: input.title,
      body: input.body ?? null,
      visibility: input.visibility,
    })
    .returning({ id: posts.id, slug: posts.slug });

  const created = rows[0];
  if (!created) throw new Error("Could not create the post.");
  return created;
}

/** Remove a post. Used to roll back when queueing its job fails. */
export async function deletePostById(id: string, db: Database = getDb()): Promise<void> {
  await db.delete(posts).where(eq(posts.id, id));
}

/**
 * Does this slug already exist?
 *
 * A slug is part of a permanent federated URL, so a collision must never reuse or
 * replace the existing post.
 */
export async function slugExists(slug: string, db: Database = getDb()): Promise<boolean> {
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.slug, slug))
    .limit(1);
  return rows.length > 0;
}

/** The id of a post that may be counted as a view, or undefined. */
export async function findViewablePostId(
  slug: string,
  db: Database = getDb(),
): Promise<string | undefined> {
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(VISIBLE, eq(posts.slug, slug)))
    .limit(1);
  return rows[0]?.id;
}
