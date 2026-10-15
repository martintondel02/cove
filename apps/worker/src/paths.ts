/**
 * The on-disk layout, and the guard that stops a transcode from filling the disk.
 *
 * Everything lives under one root so that a backup is a single directory, and so
 * that the atomic rename that publishes a video never crosses a filesystem
 * boundary — `rename(2)` is only atomic within one.
 *
 *   <root>/uploads/     incoming tus uploads, not yet processed
 *   <root>/work/<job>/  scratch space for an in-flight job
 *   <root>/media/<post>/published, immutable from the player's point of view
 *   <root>/recordings/  livestream captures (Phase 4)
 */
import { mkdir, rename, rm, statfs } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface DataLayout {
  readonly root: string;
  readonly uploads: string;
  readonly work: string;
  readonly media: string;
  readonly recordings: string;
}

export function dataLayout(root?: string): DataLayout {
  const resolved = resolve(root ?? process.env.COVE_DATA_DIR ?? "/data");
  return {
    root: resolved,
    uploads: join(resolved, "uploads"),
    work: join(resolved, "work"),
    media: join(resolved, "media"),
    recordings: join(resolved, "recordings"),
  };
}

export async function ensureLayout(layout: DataLayout): Promise<void> {
  await Promise.all([
    mkdir(layout.uploads, { recursive: true }),
    mkdir(layout.work, { recursive: true }),
    mkdir(layout.media, { recursive: true }),
    mkdir(layout.recordings, { recursive: true }),
  ]);
}

export function workDirFor(layout: DataLayout, jobId: string): string {
  return join(layout.work, jobId);
}

export function mediaDirFor(layout: DataLayout, postId: string): string {
  return join(layout.media, postId);
}

/** Media paths are stored relative to the data root, never as host paths. */
export function toStoredPath(layout: DataLayout, absolute: string): string {
  return relative(layout.root, absolute).split("\\").join("/");
}

export function fromStoredPath(layout: DataLayout, stored: string): string {
  return isAbsolute(stored) ? stored : join(layout.root, stored);
}

/** Free space in megabytes at a path. */
export async function freeMegabytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return Math.floor((stats.bsize * stats.bavail) / (1024 * 1024));
}

export class InsufficientSpaceError extends Error {
  override readonly name = "InsufficientSpaceError";
}

/**
 * Refuse to start an encode that the disk cannot finish.
 *
 * A full disk mid-encode is the single most common way a self-hosted media server
 * breaks: it corrupts the output, leaves the job wedged, and the operator finds out
 * days later. Checking up front turns that into a clear, immediate message.
 *
 * The required headroom is deliberately generous — an encode needs room for the
 * ladder plus the artefacts, and the source is still on disk.
 */
export async function assertSpaceFor(
  path: string,
  minimumMegabytes: number,
): Promise<void> {
  const free = await freeMegabytes(path);
  if (free < minimumMegabytes) {
    throw new InsufficientSpaceError(
      `Only ${free} MB free at ${path}, but a job needs at least ${minimumMegabytes} MB. ` +
        `Free some space, or lower COVE_MIN_FREE_MB if you know the job is small.`,
    );
  }
}

/**
 * Replace `destination` with `staging`, atomically if the platform allows.
 *
 * The existing directory is moved aside first rather than deleted, so that a
 * failure between the two steps leaves the previous version recoverable instead of
 * a post pointing at media that no longer exists.
 */
export async function swapIntoPlace(
  staging: string,
  destination: string,
): Promise<void> {
  const backup = `${destination}.previous-${Date.now()}`;
  let hadPrevious = false;

  try {
    await rename(destination, backup);
    hadPrevious = true;
  } catch {
    // Nothing there yet — the common case for a first publish.
  }

  try {
    await rename(staging, destination);
  } catch (error) {
    if (hadPrevious) {
      // Put the old version back; a failed publish must not destroy a working one.
      await rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }

  if (hadPrevious) {
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }
}
