/**
 * Filesystem path resolution, which differs between `next dev` and the
 * standalone production image.
 *
 * In development, pnpm runs the package script with the *package* directory as
 * the working directory (`apps/web`), so the repository's `drizzle/` folder is
 * two levels up. In production the standalone bundle runs with `/app` as the
 * working directory and the migrations are copied to `/app/drizzle`. Rather
 * than encode that in one fragile default, we probe the candidates and report
 * the choice — and the error message lists every path we tried.
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Candidate locations, most specific first. */
const CANDIDATES = [
  // Explicit override always wins.
  process.env.COVE_MIGRATIONS_DIR,
  // Standalone production image (compose sets COVE_MIGRATIONS_DIR too).
  "./drizzle",
  // `next dev` / `next build` run from apps/web.
  "../../drizzle",
  // Tolerate being invoked from apps/web/src or a nested script.
  "../../../drizzle",
].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

export function resolveMigrationsDir(): string {
  const tried: string[] = [];

  for (const candidate of CANDIDATES) {
    // The `turbopackIgnore` hint matters: without it Turbopack sees a dynamic
    // path.resolve() at build time and conservatively traces *every* reachable
    // file into the standalone output — which pulled the entire source tree,
    // globals.css included, into the production image. This call is a runtime
    // probe of a small fixed set of candidates, so tracing buys nothing.
    const absolute = isAbsolute(candidate)
      ? candidate
      : resolve(/* turbopackIgnore: true */ process.cwd(), candidate);
    tried.push(absolute);
    if (existsSync(absolute)) return absolute;
  }

  throw new Error(
    "Could not find the migrations folder. Cove cannot start without it.\n" +
      `  Tried:\n${tried.map((path) => `    ${path}`).join("\n")}\n` +
      "  If you are running from source, generate them with: pnpm db:generate",
  );
}
