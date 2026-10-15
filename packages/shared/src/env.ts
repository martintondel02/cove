/**
 * Environment parsing. Every variable has a working default so a fresh clone
 * starts without a `.env`, and a missing *required* value produces an
 * actionable message naming the variable — never a stack trace halfway through
 * boot. This is the config half of the "self-hosting is a feature" contract in
 * docs/PLAN.md §9.
 *
 * Validation is deliberately implemented with the stable core of the zod API
 * (string/number/enum/refine) rather than the newest helpers, so a minor zod
 * upgrade cannot break the boot path.
 */
import { z } from "zod";

import { normalizeSiteUrl } from "./ids.ts";
import { VISIBILITIES } from "./visibility.ts";

export const POWER_PRESETS = ["remux-first", "low-power", "balanced", "quality"] as const;
export type PowerPreset = (typeof POWER_PRESETS)[number];

const httpUrl = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an absolute http(s) URL, e.g. https://cove.example.com");

const handle = z
  .string()
  .trim()
  .toLowerCase()
  .refine(
    (value) => /^[a-z0-9](?:[a-z0-9_]{0,28}[a-z0-9])?$/.test(value),
    "must be 1-30 chars of a-z, 0-9 or underscore, and cannot start or end with an underscore",
  );

const nonEmptySecret = z.string().min(32, "must be at least 32 characters — generate one with `openssl rand -hex 32`");

/**
 * Environment booleans, parsed explicitly.
 *
 * Deliberately NOT `z.coerce.boolean()`. That coerces with `Boolean(value)`, and
 * `Boolean("false")` is `true` — so `COVE_LIVE_ENABLED=false` would switch live
 * streaming ON and `COVE_FEDERATION_ENABLED=false` would open the inbox. Silent
 * inversion of a feature flag is the worst kind of config bug: everything looks
 * right, and the behaviour is the opposite of what the file says.
 *
 * Only conventional affirmative strings count as true; anything else is false.
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === "boolean"
      ? value
      : ["true", "1", "yes", "on"].includes(value.trim().toLowerCase()),
  );

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Identity. The site URL and handle together form the federated identity, so
  // both are required — there is no safe default for either.
  COVE_SITE_URL: httpUrl,
  COVE_HANDLE: handle,
  COVE_SITE_NAME: z.string().trim().min(1).default("Cove"),
  COVE_SITE_TAGLINE: z.string().trim().default("A quiet corner of the internet."),

  DATABASE_URL: z.string().trim().min(1, "is required — the bundled Postgres sets this for you"),

  // Sessions are signed with this, so it must be strong in production. In
  // development a fixed value is allowed to keep `pnpm dev` frictionless.
  COVE_SESSION_SECRET: z.string().default(""),
  COVE_SECRET_KEY: z.string().default(""),

  COVE_POWER_PRESET: z.enum(POWER_PRESETS).default("balanced"),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  COVE_DATA_DIR: z.string().trim().min(1).default("/data"),
  COVE_MIN_FREE_MB: z.coerce.number().int().min(0).default(2048),

  COVE_LIVE_ENABLED: booleanish.default(false),
  MTX_WEBRTCADDITIONALHOSTS: z.string().trim().default(""),

  COVE_FEDERATION_ENABLED: booleanish.default(false),
  COVE_FEDERATION_ALLOW_REPLIES: booleanish.default(false),

  COVE_VISIBILITY: z.enum(VISIBILITIES).default("public"),
});

export interface Env {
  readonly nodeEnv: "development" | "test" | "production";
  readonly isProduction: boolean;
  readonly siteUrl: string;
  readonly siteName: string;
  readonly siteTagline: string;
  readonly handle: string;
  readonly databaseUrl: string;
  readonly sessionSecret: string;
  readonly secretKey: string;
  readonly powerPreset: PowerPreset;
  readonly workerConcurrency: number;
  readonly dataDir: string;
  readonly minFreeMb: number;
  readonly liveEnabled: boolean;
  readonly webrtcAdditionalHosts: string;
  readonly federationEnabled: boolean;
  readonly federationAllowReplies: boolean;
  readonly visibility: (typeof VISIBILITIES)[number];
}

export class EnvError extends Error {
  override readonly name = "EnvError";
}

/** Development-only fallback so `pnpm dev` works with no `.env` at all. */
const DEV_SECRET = "cove-development-only-secret-not-for-production-use";

/**
 * Parse and validate the environment.
 *
 * @param source defaults to `process.env`; pass an object in tests.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = rawEnvSchema.safeParse(source);

  if (!parsed.success) {
    // Group by variable so the message reads like a checklist rather than a
    // wall of zod issues.
    const byVariable = new Map<string, string[]>();
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "(root)";
      const list = byVariable.get(key) ?? [];
      list.push(issue.message);
      byVariable.set(key, list);
    }

    const lines = [...byVariable.entries()]
      .map(([key, messages]) => `  • ${key} — ${messages.join("; ")}`)
      .join("\n");

    throw new EnvError(
      `Cove could not start because some configuration is missing or invalid:\n${lines}\n\n` +
        `Run \`./setup.sh\` to generate a working .env, or copy .env.example and fill it in.`,
    );
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === "production";

  // Secrets are mandatory in production and defaulted in development. Failing
  // loudly here is much kinder than issuing forgeable session cookies.
  if (isProduction && env.COVE_SESSION_SECRET.length < 32) {
    throw new EnvError(
      "COVE_SESSION_SECRET must be set to at least 32 characters in production.\n" +
        "  Generate one with: openssl rand -hex 32",
    );
  }

  return {
    nodeEnv: env.NODE_ENV,
    isProduction,
    siteUrl: normalizeSiteUrl(env.COVE_SITE_URL),
    siteName: env.COVE_SITE_NAME,
    siteTagline: env.COVE_SITE_TAGLINE,
    handle: env.COVE_HANDLE,
    databaseUrl: env.DATABASE_URL,
    sessionSecret: env.COVE_SESSION_SECRET || DEV_SECRET,
    secretKey: env.COVE_SECRET_KEY || DEV_SECRET,
    powerPreset: env.COVE_POWER_PRESET,
    workerConcurrency: env.WORKER_CONCURRENCY,
    dataDir: env.COVE_DATA_DIR,
    minFreeMb: env.COVE_MIN_FREE_MB,
    liveEnabled: env.COVE_LIVE_ENABLED,
    webrtcAdditionalHosts: env.MTX_WEBRTCADDITIONALHOSTS,
    federationEnabled: env.COVE_FEDERATION_ENABLED,
    federationAllowReplies: env.COVE_FEDERATION_ALLOW_REPLIES,
    visibility: env.COVE_VISIBILITY,
  };
}

/** True when we are running with the development fallback secret. */
export function isUsingDevSecret(env: Env): boolean {
  return env.sessionSecret === DEV_SECRET;
}

/* ────────────────────────── worker environment ────────────────────────── */

const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().trim().min(1, "is required — the bundled Postgres sets this for you"),
  COVE_DATA_DIR: z.string().trim().min(1).default("/data"),
  COVE_MIN_FREE_MB: z.coerce.number().int().min(0).default(2048),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  COVE_POWER_PRESET: z.enum(POWER_PRESETS).default("balanced"),
  /** `libx264` (default), `nvenc`, or `qsv`. */
  COVE_VIDEO_ENCODER: z.string().trim().default("libx264"),
  /** How often to look for jobs whose worker died, in seconds. */
  COVE_JOB_SWEEP_SECONDS: z.coerce.number().int().min(10).default(60),
});

export interface WorkerEnv {
  readonly nodeEnv: "development" | "test" | "production";
  readonly databaseUrl: string;
  readonly dataDir: string;
  readonly minFreeMb: number;
  readonly concurrency: number;
  readonly powerPreset: PowerPreset;
  /** Encoder name as the operator wrote it; normalised by @cove/media. */
  readonly videoEncoder: string;
  readonly jobSweepSeconds: number;
}

/**
 * Environment for the media worker.
 *
 * Deliberately separate from `loadEnv`: the worker has no site identity, no
 * sessions and no handle, so requiring those would mean it refuses to start over
 * configuration it never uses. Splitting the schema keeps each process's
 * requirements honest, and lets `node src/index.ts` run standalone.
 */
export function loadWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues
      .map((issue) => `  • ${issue.path.join(".") || "(root)"} — ${issue.message}`)
      .join("\n");
    throw new EnvError(
      `The Cove worker could not start because its configuration is invalid:\n${lines}`,
    );
  }

  const env = parsed.data;
  return {
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    dataDir: env.COVE_DATA_DIR,
    minFreeMb: env.COVE_MIN_FREE_MB,
    concurrency: env.WORKER_CONCURRENCY,
    powerPreset: env.COVE_POWER_PRESET,
    videoEncoder: env.COVE_VIDEO_ENCODER,
    jobSweepSeconds: env.COVE_JOB_SWEEP_SECONDS,
  };
}

export { nonEmptySecret };
