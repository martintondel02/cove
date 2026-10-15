/**
 * Media job bookkeeping, and publishing a finished video.
 *
 * Two pieces of state exist for a job and they are deliberately separate:
 *
 *   • **pg-boss owns scheduling** — retries, backoff, locking, expiry. It is in its
 *     own schema and we do not touch it.
 *   • **`media_jobs` owns reporting** — what the admin UI shows: queued, running,
 *     how far along, and why it failed.
 *
 * Mixing them would mean the UI reading pg-boss internals, which is a private
 * implementation detail we would be stuck with forever.
 */
import { and, desc, eq, inArray, lt } from "drizzle-orm";

import { getDb, type Database } from "./client.ts";
import { mediaAssets, mediaJobs, posts, videos, type MediaJob } from "./schema.ts";

/** Every state a media job can be in, mirroring the pg enum. */
export type JobState = (typeof mediaJobs.state.enumValues)[number];

export interface CreateJobInput {
  readonly postId: string;
  /** Free-form job kind, e.g. `video.ingest`. */
  readonly kind: string;
  readonly payload?: Record<string, unknown>;
}

export async function createMediaJob(
  input: CreateJobInput,
  db: Database = getDb(),
): Promise<MediaJob> {
  const rows = await db
    .insert(mediaJobs)
    .values({
      postId: input.postId,
      kind: input.kind,
      state: "queued",
      payload: input.payload ?? null,
    })
    .returning();

  const job = rows[0];
  if (!job) throw new Error("Failed to create a media job row.");
  return job;
}

export interface UpdateJobInput {
  readonly state?: JobState;
  readonly progress?: number;
  readonly error?: string | null;
  readonly attempts?: number;
  /** Written on every update while running, so a stale job can be detected. */
  readonly heartbeat?: boolean;
  readonly finished?: boolean;
}

export async function updateMediaJob(
  id: string,
  input: UpdateJobInput,
  db: Database = getDb(),
): Promise<void> {
  await db
    .update(mediaJobs)
    .set({
      ...(input.state ? { state: input.state } : {}),
      ...(input.progress !== undefined ? { progress: Math.max(0, Math.min(100, input.progress)) } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
      ...(input.heartbeat ? { heartbeatAt: new Date() } : {}),
      ...(input.finished ? { finishedAt: new Date() } : {}),
    })
    .where(eq(mediaJobs.id, id));
}

/**
 * Requeue jobs whose worker died.
 *
 * pg-boss will also retry, but this makes the *reported* state honest quickly
 * rather than leaving a job showing "running 42%" for hours after the container
 * it was running in was removed.
 */
export async function requeueStaleJobs(
  staleAfterMs: number,
  db: Database = getDb(),
): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const updated = await db
    .update(mediaJobs)
    .set({ state: "queued", error: "Worker stopped responding; requeued." })
    .where(and(eq(mediaJobs.state, "running"), lt(mediaJobs.heartbeatAt, cutoff)))
    .returning({ id: mediaJobs.id });
  return updated.length;
}

/** The most recent job for a post, for the admin UI. */
export async function findLatestJobForPost(
  postId: string,
  db: Database = getDb(),
): Promise<MediaJob | undefined> {
  const rows = await db
    .select()
    .from(mediaJobs)
    .where(eq(mediaJobs.postId, postId))
    .orderBy(desc(mediaJobs.createdAt))
    .limit(1);
  return rows[0];
}

export interface PublishAsset {
  readonly role: (typeof mediaAssets.role.enumValues)[number];
  /** Path relative to COVE_DATA_DIR. */
  readonly path: string;
  readonly mime: string;
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly thumbhash?: string;
  readonly dominantColor?: string;
}

export interface PublishVideoInput {
  readonly postId: string;
  readonly jobId?: string;
  readonly masterPlaylist: string;
  readonly renditions: readonly unknown[];
  readonly assets: readonly PublishAsset[];
  readonly remuxOnly: boolean;
  readonly durationMs?: number;
  readonly posterColor?: string;
}

/**
 * Make a processed video live, in one transaction.
 *
 * Atomic on purpose: a post must never be visible while pointing at half-written
 * media. Either the renditions, the poster and the post's `published_at` all land
 * together, or none of them do and the job is retried.
 */
export async function publishVideo(
  input: PublishVideoInput,
  db: Database = getDb(),
): Promise<void> {
  await db.transaction(async (tx) => {
    // Replace rather than append: re-processing a post (a different preset, a
    // retry after a partial failure) must not leave orphaned rows pointing at
    // segments that no longer exist.
    await tx.delete(mediaAssets).where(eq(mediaAssets.postId, input.postId));

    if (input.assets.length > 0) {
      await tx.insert(mediaAssets).values(
        input.assets.map((asset) => ({
          postId: input.postId,
          role: asset.role,
          path: asset.path,
          mime: asset.mime,
          bytes: asset.bytes ?? null,
          width: asset.width ?? null,
          height: asset.height ?? null,
          durationMs: asset.durationMs ?? null,
          thumbhash: asset.thumbhash ?? null,
          dominantColor: asset.dominantColor ?? null,
        })),
      );
    }

    await tx
      .insert(videos)
      .values({
        postId: input.postId,
        masterPlaylist: input.masterPlaylist,
        renditions: [...input.renditions],
        remuxOnly: input.remuxOnly,
      })
      .onConflictDoUpdate({
        target: videos.postId,
        set: {
          masterPlaylist: input.masterPlaylist,
          renditions: [...input.renditions],
          remuxOnly: input.remuxOnly,
        },
      });

    await tx
      .update(posts)
      .set({ publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(posts.id, input.postId));

    if (input.jobId) {
      await tx
        .update(mediaJobs)
        .set({ state: "ready", progress: 100, finishedAt: new Date(), error: null })
        .where(eq(mediaJobs.id, input.jobId));
    }
  });
}

/** Posts that are still waiting on media, used to show progress in the UI. */
export async function listUnpublishedPosts(
  limit = 20,
  db: Database = getDb(),
): Promise<{ id: string; title: string; slug: string }[]> {
  return db
    .select({ id: posts.id, title: posts.title, slug: posts.slug })
    .from(posts)
    .where(and(eq(posts.visibility, "public"), inArray(posts.kind, ["video", "reel"])))
    .orderBy(desc(posts.createdAt))
    .limit(limit);
}
