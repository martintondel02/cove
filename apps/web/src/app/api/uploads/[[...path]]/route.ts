/**
 * Resumable uploads (tus 1.0.0).
 *
 * `@tus/server` exposes a Fetch-API entry point (`handleWeb`), so it drops into a
 * Next route handler directly — no Node `IncomingMessage` adapter needed.
 *
 * Auth lives in this wrapper rather than in the library's callbacks, because the
 * callbacks can only reject by throwing, which gives a default 500. Checking here
 * means a rejected upload gets an honest 401 and the browser sees why.
 *
 * Files land in `<data root>/uploads/<id>`, which is the same volume the worker
 * reads, so handing a job over is a rename rather than a copy.
 */
import { FileStore } from "@tus/file-store";
import { Server } from "@tus/server";

import { requireAdmin } from "@/lib/auth";
import { uploadsDir } from "@/lib/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** File extensions ffprobe and the pipeline are happy to handle. */
const ALLOWED_EXTENSIONS = new Set([
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "mpg", "mpeg", "ts", "m2ts", "3gp", "flv", "wmv",
]);

/** 32 GB. Generous, but not unbounded — a runaway client should be stopped. */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024 * 1024;

class UploadRejected extends Error {
  // `@tus/server` reads these off a thrown error to build the response.
  readonly status_code = 400;
  readonly body: string;
  constructor(message: string) {
    super(message);
    this.name = "UploadRejected";
    this.body = JSON.stringify({ error: message });
  }
}

function extensionOf(filename: string | null | undefined): string {
  if (!filename) return "";
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
  return match?.[1]?.toLowerCase() ?? "";
}

let cached: Server | undefined;

function tusServer(): Server {
  cached ??= new Server({
    path: "/api/uploads",
    datastore: new FileStore({ directory: uploadsDir() }),
    // Behind Caddy, so the Location header must be built from the forwarded host
    // or the client would be told to resume against the container's own name.
    respectForwardedHeaders: true,
    maxSize: MAX_UPLOAD_BYTES,
    // Same-origin only: the upload endpoint is for this site's own pages.
    allowedOrigins: [],
    onUploadCreate: async (_request, upload) => {
      const filename = upload.metadata?.["filename"] ?? upload.metadata?.["name"];
      const extension = extensionOf(filename);
      if (extension && !ALLOWED_EXTENSIONS.has(extension)) {
        throw new UploadRejected(
          `Cove does not accept ".${extension}" files. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}.`,
        );
      }
      return { metadata: upload.metadata };
    },
  });
  return cached;
}

async function handle(request: Request): Promise<Response> {
  const auth = requireAdmin(request);
  if (!auth.ok) return auth.response;

  try {
    return await tusServer().handleWeb(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}

export const POST = handle;
export const PATCH = handle;
export const HEAD = handle;
export const DELETE = handle;
export const OPTIONS = handle;
export const GET = handle;
