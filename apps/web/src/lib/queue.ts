/**
 * The web app's handle on the job queue.
 *
 * The web process only ever *sends* jobs; the worker consumes them. Both talk to
 * pg-boss, which owns scheduling in its own schema.
 *
 * The instance is cached on `globalThis` because Next's dev server re-evaluates
 * modules on every hot reload, and a fresh PgBoss per reload would leak a
 * connection pool each time.
 */
import { PgBoss } from "pg-boss";

import { getEnvState } from "./env";

/** Must match `MEDIA_QUEUE` in apps/worker. */
export const MEDIA_QUEUE = "media.process";

export interface EnqueueMediaJob {
  readonly mediaJobId: string;
  readonly postId: string;
  readonly sourcePath: string;
  readonly isReel?: boolean;
  readonly preset?: string;
  readonly encoder?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __coveBoss: Promise<PgBoss> | undefined;
}

async function startBoss(): Promise<PgBoss> {
  const envState = getEnvState();
  if (!envState.ok) throw new Error(envState.error);

  const boss = new PgBoss({
    connectionString: envState.env.databaseUrl,
    schema: "pgboss",
  });
  boss.on("error", (error) => console.error("[cove] pg-boss error:", error));

  await boss.start();
  // Queues must exist before a send; creating an existing queue is a no-op.
  await boss.createQueue(MEDIA_QUEUE, {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 60 * 60 * 6,
  });
  return boss;
}

export function getBoss(): Promise<PgBoss> {
  globalThis.__coveBoss ??= startBoss().catch((error: unknown) => {
    // Do not cache a failed start, or the app would never recover once the
    // database came back.
    globalThis.__coveBoss = undefined;
    throw error;
  });
  return globalThis.__coveBoss;
}

/**
 * Queue a media job.
 *
 * Returns the pg-boss job id, or null when the queue refused it. Throwing is left
 * to the caller so it can decide whether a failure to enqueue should fail the whole
 * request — it should, because a post with no job is a post that never appears.
 */
export async function enqueueMediaJob(job: EnqueueMediaJob): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(MEDIA_QUEUE, {
    mediaJobId: job.mediaJobId,
    postId: job.postId,
    sourcePath: job.sourcePath,
    isReel: job.isReel ?? false,
    preset: job.preset ?? "balanced",
    ...(job.encoder ? { encoder: job.encoder } : {}),
  });
}
