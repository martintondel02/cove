/**
 * The Cove media worker.
 *
 * Runs one queue, `media.process`, at a configurable concurrency (1 by default —
 * a second concurrent transcode on a small box makes everything slower, including
 * the first one).
 *
 * Scheduling belongs to pg-boss; reporting belongs to the `media_jobs` table. See
 * packages/db/src/media-jobs.ts for why those are kept apart.
 */
// pg-boss v12 has no default export.
import { PgBoss } from "pg-boss";

import { closeDb, getDb, requeueStaleJobs } from "@cove/db";
import { loadWorkerEnv, type WorkerEnv } from "@cove/shared";

import { dataLayout, ensureLayout } from "./paths.ts";
import { markJobFailed, processMediaJob, type MediaJobPayload } from "./pipeline.ts";

export const MEDIA_QUEUE = "media.process";

/** A job whose worker stopped reporting is presumed dead after this long. */
const STALE_JOB_MS = 15 * 60 * 1000;

function log(message: string): void {
  console.log(`[cove] ${message}`);
}

async function main(): Promise<void> {
  const env: WorkerEnv = loadWorkerEnv();
  const layout = dataLayout(env.dataDir);
  await ensureLayout(layout);
  log(`data root ${layout.root}`);
  log(`encoder ${env.videoEncoder}, concurrency ${env.concurrency}`);

  const db = getDb({ connectionString: env.databaseUrl, max: 4 + env.concurrency });

  const boss = new PgBoss({ connectionString: env.databaseUrl, schema: "pgboss" });
  boss.on("error", (error) => console.error("[cove] pg-boss error:", error));

  await boss.start();
  log("connected to the job queue");

  // Queues must be created explicitly; sending to one that does not exist rejects.
  await boss.createQueue(MEDIA_QUEUE, {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    // Generous, because a 4K transcode on modest hardware genuinely can run for
    // hours — expiring it would restart work that was nearly finished.
    expireInSeconds: 60 * 60 * 6,
  });

  // Anything left "running" by a killed worker goes back in the queue, so the
  // reported state does not lie for hours after a container is removed.
  const rehomed = await requeueStaleJobs(STALE_JOB_MS, db);
  if (rehomed > 0) log(`requeued ${rehomed} stale job(s)`);

  const sweep = setInterval(() => {
    void requeueStaleJobs(STALE_JOB_MS, db)
      .then((count) => {
        if (count > 0) log(`requeued ${count} stale job(s)`);
      })
      .catch((error: unknown) => console.error("[cove] stale sweep failed:", error));
  }, env.jobSweepSeconds * 1000);
  sweep.unref();

  await boss.work<MediaJobPayload>(
    MEDIA_QUEUE,
    // `localConcurrency` (not `teamSize`, which v12 does not have) spawns N
    // independent pollers for this queue.
    { batchSize: 1, localConcurrency: env.concurrency },
    async (jobs) => {
      const job = jobs[0];
      if (!job) return;

      const started = Date.now();
      try {
        await processMediaJob(
          job.id,
          job.data,
          { layout, minFreeMb: env.minFreeMb, log },
          db,
        );
        log(`job ${job.id} finished in ${Math.round((Date.now() - started) / 1000)}s`);
      } catch (error) {
        // Record the failure so the admin UI can show it, then rethrow so pg-boss
        // applies its own retry policy. If a retry succeeds, publishVideo flips the
        // row to `ready` and clears the error — the transient failed state is
        // honest rather than misleading.
        // Report against the media_jobs row, not the queue id — see the note on
        // MediaJobPayload.mediaJobId.
        await markJobFailed(job.data.mediaJobId, error, db).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[cove] job ${job.id} failed: ${message}`);
        throw error;
      }
    },
  );

  log(`worker ready — waiting for jobs on "${MEDIA_QUEUE}"`);

  const shutdown = async (signal: string): Promise<void> => {
    log(`${signal} received, finishing current job…`);
    clearInterval(sweep);
    // `graceful` lets an in-flight encode finish rather than throwing away an hour
    // of work; the container's stop timeout must be long enough to allow it.
    await boss.stop({ graceful: true, timeout: 120_000 }).catch(() => undefined);
    await closeDb().catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(
    "[cove] the worker could not start:\n" +
      (error instanceof Error ? error.message : String(error)),
  );
  process.exit(1);
});
