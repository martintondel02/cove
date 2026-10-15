/**
 * Creating a post: the handover from upload to worker.
 *
 * Three things have to happen together — the post row, the job row, and the queue
 * entry — and the ordering matters. The post is created first (so the job has
 * something to publish into), then the job row (so the worker has a row to report
 * against), then the queue message. If enqueueing fails the post is removed again,
 * because a post with no job is a post that silently never appears.
 */
import { rename, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  createMediaJob,
  deletePostById,
  getActorByHandle,
  insertPost,
  listPublishedVideos,
  slugExists,
} from "@cove/db";
import { isVisibility, postUri, slugify, type Visibility } from "@cove/shared";

import { requireAdmin } from "@/lib/auth";
import { getEnvState } from "@/lib/env";
import { uploadsDir } from "@/lib/media";
import { enqueueMediaJob } from "@/lib/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALLOWED_EXTENSIONS = new Set([
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg", "ts", "m2ts", "3gp", "flv", "wmv",
]);

interface CreatePostBody {
  readonly title?: unknown;
  readonly uploadId?: unknown;
  readonly filename?: unknown;
  readonly description?: unknown;
  readonly visibility?: unknown;
  readonly isReel?: unknown;
}

function bad(error: string, hint?: string, status = 400): Response {
  return Response.json({ error, ...(hint ? { hint } : {}) }, { status });
}

/**
 * Make a slug that is unique.
 *
 * A slug is part of a permanent, federated URL, so it is never reused: a collision
 * gets a numeric suffix rather than replacing the existing post.
 */
async function uniqueSlug(base: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (!(await slugExists(candidate))) return candidate;
  }
  // Fall back to something certainly unique rather than looping forever.
  return `${base}-${Date.now().toString(36)}`;
}

export async function POST(request: Request): Promise<Response> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  const envState = getEnvState();
  if (!envState.ok) return bad("Cove is not configured yet.", envState.error, 503);
  const env = envState.env;

  let body: CreatePostBody;
  try {
    body = (await request.json()) as CreatePostBody;
  } catch {
    return bad("Expected a JSON body.");
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length === 0) return bad("A title is required.");
  if (title.length > 300) return bad("That title is too long (300 characters max).");

  const uploadId = typeof body.uploadId === "string" ? body.uploadId.trim() : "";
  // The tus id is a hex string; anything else is either a mistake or an attempt to
  // escape the uploads directory.
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(uploadId)) {
    return bad("uploadId is missing or malformed.", "Upload a file first, then reference its id.");
  }

  const filename = typeof body.filename === "string" ? body.filename : "";
  const extension = (/\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1] ?? "").toLowerCase();
  if (extension && !ALLOWED_EXTENSIONS.has(extension)) {
    return bad(`Cove cannot process ".${extension}" files.`);
  }

  const visibility: Visibility = isVisibility(body.visibility) ? body.visibility : env.visibility;
  const isReel = body.isReel === true;

  const actor = await getActorByHandle(env.handle);
  if (!actor) {
    return bad("The owner account does not exist yet.", "Check the web container logs.", 503);
  }

  // Give the upload its real extension. ffprobe sniffs content so it copes either
  // way, but ffmpeg derives the HLS init/segment naming and some containers'
  // demuxers from the suffix, and a named file is far easier to debug.
  let sourcePath = join(uploadsDir(), uploadId);
  try {
    await stat(sourcePath);
  } catch {
    return bad("That upload does not exist.", "It may have expired. Try uploading again.");
  }

  if (extension) {
    const withExtension = `${sourcePath}.${extension}`;
    try {
      await rename(sourcePath, withExtension);
      sourcePath = withExtension;
    } catch {
      // Fall through with the extension-less path; the pipeline still copes.
    }
  }

  const slug = await uniqueSlug(slugify(title, `video-${uploadId.slice(0, 8)}`));

  let post: { id: string; slug: string };
  try {
    post = await insertPost({
      authorId: actor.id,
      kind: isReel ? "reel" : "video",
      slug,
      // Minted once, never renumbered: this becomes the post's federated identity.
      uri: postUri(env.siteUrl, slug),
      title,
      body: typeof body.description === "string" ? body.description : null,
      visibility,
    });
  } catch (error) {
    return bad("Could not create the post.", (error as Error).message, 500);
  }

  try {
    const job = await createMediaJob({
      postId: post.id,
      kind: "video.ingest",
      payload: { sourcePath, filename },
    });

    const queued = await enqueueMediaJob({
      mediaJobId: job.id,
      postId: post.id,
      sourcePath,
      isReel,
      preset: env.powerPreset,
    });

    if (!queued) throw new Error("The job queue refused the job.");

    return Response.json(
      {
        post: { id: post.id, slug: post.slug, url: `/watch/${post.slug}` },
        job: { id: job.id },
        status: "processing",
      },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // Roll back: leaving the post would produce an empty entry nobody can watch.
    await deletePostById(post.id).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    return bad("Could not queue the video for processing.", message, 503);
  }
}

export async function GET(): Promise<Response> {
  const videos = await listPublishedVideos(48);
  return Response.json(
    {
      posts: videos.map((video) => ({
        slug: video.slug,
        title: video.title,
        publishedAt: video.publishedAt,
        url: `/watch/${video.slug}`,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
