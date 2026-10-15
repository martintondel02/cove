/**
 * Liveness/readiness endpoint.
 *
 * Returns 503 rather than 200 when a dependency is down, so a container health
 * check and the `doctor` script both get an honest answer. Deliberately does not
 * leak configuration values — only whether they are present.
 */
import { ping } from "@cove/db";

import { getEnvState } from "@/lib/env";

export const dynamic = "force-dynamic";

interface Check {
  readonly ok: boolean;
  readonly detail?: string;
}

export async function GET(): Promise<Response> {
  const startedAt = Date.now();
  const checks: Record<string, Check> = {};

  const envState = getEnvState();
  checks.config = envState.ok
    ? { ok: true }
    : {
        ok: false,
        detail:
          envState.missing.length > 0
            ? `missing: ${envState.missing.join(", ")}`
            : "invalid configuration",
      };

  if (envState.ok) {
    const databaseOk = await ping();
    checks.database = databaseOk ? { ok: true } : { ok: false, detail: "unreachable" };
  } else {
    checks.database = { ok: false, detail: "skipped — not configured" };
  }

  const ok = Object.values(checks).every((check) => check.ok);

  return Response.json(
    {
      service: "cove-web",
      status: ok ? "ok" : "degraded",
      checks,
      uptimeSeconds: Math.round(process.uptime()),
      tookMs: Date.now() - startedAt,
    },
    {
      status: ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
