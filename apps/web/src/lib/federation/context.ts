/**
 * Shared setup for the federation endpoints: resolve configuration, then the
 * actor, and turn either failure into a response with a useful explanation.
 *
 * Centralised so each route stays about *its* representation rather than about
 * repeating the same three checks — and so the "not configured yet" and "not
 * seeded yet" messages are identical everywhere.
 */
import { getActorByHandle, type Actor } from "@cove/db";
import { siteDomain, type Env } from "@cove/shared";

import { getEnvState } from "@/lib/env";
import { AS2_CONTENT_TYPE } from "@/lib/federation/accept";

export interface FederationContext {
  readonly env: Env;
  readonly domain: string;
  readonly actor: Actor;
}

export type FederationLookup =
  | { readonly ok: true; readonly context: FederationContext }
  | { readonly ok: false; readonly response: Response };

function problem(status: number, error: string, hint?: string): Response {
  return new Response(JSON.stringify({ error, ...(hint ? { hint } : {}) }, null, 2), {
    status,
    headers: { "content-type": AS2_CONTENT_TYPE, vary: "Accept", "cache-control": "no-store" },
  });
}

export async function loadFederationContext(handle: string): Promise<FederationLookup> {
  const envState = getEnvState();
  if (!envState.ok) {
    return {
      ok: false,
      response: problem(503, "This Cove instance is not configured yet.", envState.error),
    };
  }

  const env = envState.env;
  const domain = siteDomain(env.siteUrl);

  if (handle !== env.handle) {
    return {
      ok: false,
      // Not a 404 with a vague body: naming the handle we do serve is what makes
      // a misconfigured client obvious during setup.
      response: problem(404, `No such account: ${handle}`, `This instance serves @${env.handle}@${domain}.`),
    };
  }

  try {
    const actor = await getActorByHandle(handle);
    if (!actor) {
      return {
        ok: false,
        response: problem(
          503,
          "The owner account has not been created yet.",
          "Cove seeds it on first boot — check the web container logs.",
        ),
      };
    }
    return { ok: true, context: { env, domain, actor } };
  } catch (error) {
    return {
      ok: false,
      response: problem(503, "The database is unavailable.", (error as Error).message),
    };
  }
}
