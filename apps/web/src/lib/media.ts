/**
 * Where media lives, from the web app's point of view.
 *
 * The database stores every asset path **relative to the data root** (e.g.
 * `media/<postId>/master.m3u8`). That choice keeps the database portable — it never
 * contains a host path — and it makes the public URL almost free: the stored path
 * already begins with `media/`, and Caddy serves `/media/*` straight off the same
 * volume, so a stored path *is* its URL.
 *
 * Serving media through Caddy rather than through Next matters: it gets range
 * requests, sendfile, and cache semantics for free, and Node never has to shovel
 * video bytes through the event loop.
 */
import { join, resolve } from "node:path";

export function dataRoot(): string {
  return resolve(process.env.COVE_DATA_DIR ?? "/data");
}

export function uploadsDir(): string {
  return join(dataRoot(), "uploads");
}

/**
 * The public URL for a stored asset path.
 *
 * Caddy is configured to serve `/media/*` from `<data root>/media`, so this is a
 * direct mapping rather than an application route.
 */
export function mediaUrl(storedPath: string): string {
  const trimmed = storedPath.replace(/^\/+/, "");
  return `/${trimmed}`;
}

/** Absolute path on disk for a stored asset path. */
export function absoluteMediaPath(storedPath: string): string {
  return join(dataRoot(), storedPath.replace(/^\/+/, ""));
}
