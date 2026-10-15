/**
 * Environment access for the web app.
 *
 * `loadEnv()` throws on invalid configuration, which is right at boot but wrong
 * at render time: a missing variable should produce a *screenshot-able
 * explanation*, not a stack trace, and it must not break `next build` on a
 * machine with no `.env` (which is exactly what CI is).
 *
 * So `getEnvState()` never throws, and callers decide how loud to be.
 */
import { EnvError, loadEnv, type Env } from "@cove/shared";

export type EnvState =
  | { readonly ok: true; readonly env: Env }
  | { readonly ok: false; readonly error: string; readonly missing: readonly string[] };

/** Variables that have no safe default and therefore block startup. */
const REQUIRED = ["COVE_SITE_URL", "COVE_HANDLE", "DATABASE_URL"] as const;

export function getEnvState(): EnvState {
  try {
    return { ok: true, env: loadEnv(process.env) };
  } catch (error) {
    const message =
      error instanceof EnvError
        ? error.message
        : `Unexpected configuration error: ${(error as Error).message}`;

    // Best-effort list of what is actually absent, so the UI can point at it.
    const missing = REQUIRED.filter((key) => {
      const value = process.env[key];
      return value === undefined || value.trim() === "";
    });

    return { ok: false, error: message, missing };
  }
}

/** Throwing accessor, for code paths that genuinely cannot continue. */
export function getEnv(): Env {
  const state = getEnvState();
  if (!state.ok) throw new EnvError(state.error);
  return state.env;
}
