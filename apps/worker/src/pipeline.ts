/**
 * The media pipeline: upload file in, published video out.
 *
 * The shape of this is driven by one rule: **a job must be safe to run twice.**
 * pg-boss retries, containers get killed, disks fill up, and a personal site has
 * nobody watching. So every side effect is either idempotent or guarded, all work
 * happens in a scratch directory, and the only mutation that can make a half-built
 * video visible is a single `rename(2)` at the end.
 *
 *   1. claim the job and start a heartbeat
 *   2. refuse to start unless the disk can finish
 *   3. hard-link the upload into scratch (no copy, no extra space)
 *   4. probe it
 *   5. decide what to do — usually "copy the bytes"
 *   6. encode into scratch/out, reporting progress
 *   7. derive poster, ambient colour and scrubber sprite
 *   8. swap scratch/out into media/<postId> atomically
 *   9. publish in one transaction, then clean up
 */
import { copyFile, link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import {
  publishVideo,
  updateMediaJob,
  type Database,
  type PublishAsset,
} from "@cove/db";
import {
  buildCopyArgs,
  buildCopyVideoArgs,
  buildSpriteVtt,
  buildTranscodeArgs,
  decide,
  parseAverageColor,
  posterArgs,
  probe,
  averageColorArgs,
  run,
  runOrThrow,
  spriteArgs,
  spriteIntervalSeconds,
  type Decision,
  type EncoderKind,
  type ProbeResult,
  type ProcessMode,
} from "@cove/media";
import type { PowerPreset } from "@cove/shared";

import {
  assertSpaceFor,
  mediaDirFor,
  swapIntoPlace,
  toStoredPath,
  workDirFor,
  type DataLayout,
} from "./paths.ts";
import { PROGRESS_ARGS, ProgressTracker } from "./progress.ts";

/** What the web app puts on the queue. */
export interface MediaJobPayload {
  /**
   * The `media_jobs` row this run reports against.
   *
   * Deliberately distinct from the pg-boss job id: pg-boss owns scheduling in its
   * own schema, while `media_jobs` is what the admin UI reads. Conflating them meant
   * progress updates silently matched no row, so a job would run to completion with
   * the UI still showing "queued".
   */
  readonly mediaJobId: string;
  readonly postId: string;
  /** Absolute path to the uploaded file, before processing. */
  readonly sourcePath: string;
  readonly isReel?: boolean;
  readonly preset?: PowerPreset;
  readonly encoder?: EncoderKind;
}

export interface PipelineOptions {
  readonly layout: DataLayout;
  readonly minFreeMb: number;
  readonly log?: (message: string) => void;
}

export interface PipelineResult {
  readonly mode: ProcessMode;
  readonly renditions: readonly string[];
  readonly durationSeconds: number;
  readonly dominantColor: string | null;
}

/** Poster width, and the sprite thumbnail width, in pixels. */
const POSTER_WIDTH = 1280;
const SPRITE_WIDTH = 160;
const SPRITE_COLUMNS = 10;
const SPRITE_ROWS = 10;
/** ffmpeg's image2 muxer numbers from 1, so the first sheet is sprite_001.jpg. */
const SPRITE_SHEET_NAME = "sprite_%03d.jpg";

/** ffmpeg's global options must precede the input. */
function withProgress(args: readonly string[]): string[] {
  return [...PROGRESS_ARGS, ...args];
}

/**
 * Bring the source into scratch without duplicating it.
 *
 * A hard link is instant and costs no space, which matters because a 20 GB upload
 * should not become 40 GB just to be processed. Copying is the fallback for when the
 * uploads directory is on a different filesystem, which it normally is not.
 */
async function stageSource(sourcePath: string, workDir: string): Promise<string> {
  const extension = extname(sourcePath) || ".bin";
  const staged = join(workDir, `source${extension}`);
  await rm(staged, { force: true }).catch(() => undefined);

  try {
    await link(sourcePath, staged);
  } catch {
    await copyFile(sourcePath, staged);
  }
  return staged;
}

/** Even numbers only: H.264 cannot encode an odd dimension. */
function evenThumbHeight(width: number, sourceWidth: number, sourceHeight: number): number {
  const ratio = sourceWidth > 0 ? sourceHeight / sourceWidth : 0.5625;
  return Math.max(2, Math.round((width * ratio) / 2) * 2);
}

export async function processMediaJob(
  jobId: string,
  payload: MediaJobPayload,
  options: PipelineOptions,
  db: Database,
): Promise<PipelineResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const { layout } = options;

  const workDir = workDirFor(layout, jobId);
  const outDir = join(workDir, "out");

  const { mediaJobId } = payload;
  await updateMediaJob(mediaJobId, { state: "running", progress: 1, heartbeat: true }, db);

  // ── 2. Can the disk finish this? ───────────────────────────────────────────
  await assertSpaceFor(layout.root, options.minFreeMb);

  // A retry must not inherit a half-written directory from the previous attempt.
  await rm(workDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  let stagedSource: string | null = null;

  try {
    // ── 3. Stage the source ───────────────────────────────────────────────────
    stagedSource = await stageSource(payload.sourcePath, workDir);
    const sourceBytes = (await stat(stagedSource)).size;
    log(`[cove] job ${jobId}: source ${(sourceBytes / 1_048_576).toFixed(1)} MB`);

    // ── 4. Probe ──────────────────────────────────────────────────────────────
    const probed: ProbeResult = await probe(stagedSource);
    if (!probed.hasVideo) {
      throw new Error(
        "That file has no video stream Cove can play. If it is audio-only, it is not supported yet.",
      );
    }
    await updateMediaJob(mediaJobId, { progress: 5, heartbeat: true }, db);

    // ── 5. Decide ─────────────────────────────────────────────────────────────
    const decision: Decision = decide(probed, {
      preset: payload.preset ?? "balanced",
      isReel: payload.isReel ?? false,
    });
    log(`[cove] job ${jobId}: ${decision.mode} — ${decision.reasons.join(" ")}`);

    // ── 6. Encode ─────────────────────────────────────────────────────────────
    const tracker = new ProgressTracker(probed.durationSeconds, (percent) => {
      // Encoding occupies the first 85% of the bar; artefacts take the rest.
      void updateMediaJob(
        mediaJobId,
        { progress: Math.round(percent * 0.85), heartbeat: true },
        db,
      );
    });

    const hasAudio = probed.audio !== null;
    const fps = probed.video?.fps ?? 0;
    const encodeArgs = (() => {
      switch (decision.mode) {
        case "copy":
          return buildCopyArgs({
            input: stagedSource,
            hasAudio,
            isReel: payload.isReel,
          });
        case "copy-video-transcode-audio":
          return buildCopyVideoArgs({
            input: stagedSource,
            hasAudio,
            isReel: payload.isReel,
          });
        case "transcode":
          return buildTranscodeArgs({
            input: stagedSource,
            hasAudio,
            ladder: decision.ladder,
            isReel: payload.isReel,
            fps,
            ...(payload.encoder ? { encoder: payload.encoder } : {}),
          });
      }
    })();

    await runOrThrow("ffmpeg", withProgress(encodeArgs), {
      // The HLS output patterns are relative (`v%v/index.m3u8`), so the working
      // directory decides where they land. ffmpeg creates the `%v` directories.
      cwd: outDir,
      onStderr: (chunk) => tracker.feed(chunk),
    });

    const masterPlaylist = join(outDir, "master.m3u8");
    await stat(masterPlaylist); // fail loudly here rather than at playback
    await updateMediaJob(mediaJobId, { progress: 86, heartbeat: true }, db);

    // ── 7. Artefacts ──────────────────────────────────────────────────────────
    const videoWidth = probed.video?.width ?? 1920;
    const videoHeight = probed.video?.height ?? 1080;

    const posterPath = join(outDir, "poster.webp");
    let posterWidth: number | null = null;
    let posterHeight: number | null = null;
    const posterResult = await run(
      "ffmpeg",
      posterArgs(stagedSource, {
        output: posterPath,
        durationSeconds: probed.durationSeconds,
        width: POSTER_WIDTH,
      }),
    );
    if (posterResult.code === 0) {
      posterWidth = POSTER_WIDTH;
      posterHeight = evenThumbHeight(POSTER_WIDTH, videoWidth, videoHeight);
    } else {
      // Non-fatal on purpose: a video without a poster is still a watchable video,
      // and losing an hour of encoding over a missing thumbnail would be absurd.
      log(`[cove] job ${jobId}: poster frame failed, continuing without one`);
    }

    // Ambient colour: scale a frame to 1x1 and read three raw bytes out of a file.
    let dominantColor: string | null = null;
    const colorProbe = join(workDir, "average.rgb");
    const colorResult = await run(
      "ffmpeg",
      averageColorArgs(
        stagedSource,
        colorProbe,
        Math.min(30, Math.max(1, probed.durationSeconds * 0.1)),
      ),
    );
    if (colorResult.code === 0) {
      dominantColor = parseAverageColor(await readFile(colorProbe));
    }
    await updateMediaJob(mediaJobId, { progress: 90, heartbeat: true }, db);

    // Scrubber sprite sheet plus its WebVTT index. The interval is derived from the
    // duration and used by all three calls, because a fixed interval produces zero
    // frames for a clip shorter than that interval — which ffmpeg treats as a hard
    // error, and which would silently cost every short upload its scrubber.
    const spriteInterval = spriteIntervalSeconds(probed.durationSeconds);
    const spritePattern = join(outDir, SPRITE_SHEET_NAME);
    const spriteResult = await run("ffmpeg", spriteArgs(stagedSource, {
      outputPattern: spritePattern,
      durationSeconds: probed.durationSeconds,
      intervalSeconds: spriteInterval,
      thumbWidth: SPRITE_WIDTH,
      columns: SPRITE_COLUMNS,
      rows: SPRITE_ROWS,
    }));

    const spriteAssets: PublishAsset[] = [];
    if (spriteResult.code === 0) {
      const thumbHeight = evenThumbHeight(SPRITE_WIDTH, videoWidth, videoHeight);
      const vtt = buildSpriteVtt({
        durationSeconds: probed.durationSeconds,
        intervalSeconds: spriteInterval,
        thumbWidth: SPRITE_WIDTH,
        thumbHeight,
        columns: SPRITE_COLUMNS,
        rows: SPRITE_ROWS,
        // Must match both the file naming above and ffmpeg's 1-based numbering, or
        // every cue points at a sheet that does not exist.
        sheetPattern: SPRITE_SHEET_NAME,
        firstSheetNumber: 1,
      });
      const vttPath = join(outDir, "sprite.vtt");
      await writeFile(vttPath, vtt, "utf8");
      spriteAssets.push({
        role: "sprite",
        path: vttPath,
        mime: "text/vtt",
      });
      for (let index = 1; ; index += 1) {
        const sheet = join(outDir, `sprite_${String(index).padStart(3, "0")}.jpg`);
        try {
          const info = await stat(sheet);
          spriteAssets.push({
            role: "sprite",
            path: sheet,
            mime: "image/jpeg",
            bytes: info.size,
          });
        } catch {
          break;
        }
      }
    } else {
      // Never fail quietly: if the scrubber is missing, the log should say why.
      const detail = spriteResult.stderr.trim().split("\n").slice(-3).join(" | ");
      log(
        `[cove] job ${jobId}: sprite sheet failed (interval ${spriteInterval}s), ` +
          `continuing without scrubber previews — ${detail}`,
      );
    }

    // ── 8. Publish: one atomic swap, then one transaction ─────────────────────
    // The source travels with the media so a re-encode later needs no re-upload.
    const finalSourceName = `source${extname(stagedSource)}`;
    await copyFile(stagedSource, join(outDir, finalSourceName));

    const finalDir = mediaDirFor(layout, payload.postId);
    await mkdir(join(layout.media), { recursive: true });
    await swapIntoPlace(outDir, finalDir);

    const stored = (name: string) => toStoredPath(layout, join(finalDir, name));

    const assets: PublishAsset[] = [
      {
        role: "source",
        path: stored(finalSourceName),
        mime: "application/octet-stream",
        bytes: sourceBytes,
      },
      ...(posterWidth && posterHeight
        ? [
            {
              role: "poster" as const,
              path: stored("poster.webp"),
              mime: "image/webp",
              width: posterWidth,
              height: posterHeight,
              ...(dominantColor ? { dominantColor } : {}),
            },
          ]
        : []),
      {
        role: "hls",
        path: stored("master.m3u8"),
        mime: "application/vnd.apple.mpegurl",
      },
    ];

    // Sprite assets were built against the scratch paths; re-point them at the
    // published location.
    for (const sprite of spriteAssets) {
      assets.push({
        ...sprite,
        path: stored(sprite.path.slice(outDir.length + 1)),
      });
    }

    await publishVideo(
      {
        postId: payload.postId,
        jobId: mediaJobId,
        masterPlaylist: stored("master.m3u8"),
        renditions: decision.ladder.map((rung) => ({
          name: rung.name,
          width: rung.width,
          height: rung.height,
          videoBitrateKbps: rung.videoBitrateKbps,
        })),
        assets,
        remuxOnly: decision.mode === "copy",
        durationMs: Math.round(probed.durationSeconds * 1000),
        ...(dominantColor ? { posterColor: dominantColor } : {}),
      },
      db,
    );

    await updateMediaJob(mediaJobId, { progress: 100, heartbeat: true }, db);
    log(`[cove] job ${jobId}: published ${payload.postId} (${decision.mode})`);

    return {
      mode: decision.mode,
      renditions: decision.ladder.map((rung) => rung.name),
      durationSeconds: probed.durationSeconds,
      dominantColor,
    };
  } finally {
    // Always clean scratch, whether we succeeded or not. The published copy lives
    // under media/, so nothing is lost — and a retry starts from a clean slate.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Record a failure against a `media_jobs` row, for the admin UI. */
export async function markJobFailed(
  mediaJobId: string,
  error: unknown,
  db: Database,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await updateMediaJob(mediaJobId, { state: "failed", error: message, finished: true }, db);
}
