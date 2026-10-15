/**
 * The actor document — the single URL that identifies this person to the
 * fediverse. Reached at `/@handle` when the client sends
 * `Accept: application/activity+json` (see src/proxy.ts).
 */
import { as2Response, buildPerson } from "@/lib/federation/as2";
import { loadFederationContext } from "@/lib/federation/context";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ handle: string }> },
): Promise<Response> {
  // Next 16: route params are async-only.
  const { handle } = await context.params;
  const lookup = await loadFederationContext(handle);
  if (!lookup.ok) return lookup.response;

  const { actor, env } = lookup.context;

  return as2Response(
    buildPerson(actor, {
      siteUrl: env.siteUrl,
      // No keypair yet: HTTP signatures are what Phase 5 adds, and without one
      // remote servers will fetch this actor but reject deliveries. Stated here
      // rather than silently omitted, because it is the one gap in the identity.
      federationEnabled: env.federationEnabled,
    }),
  );
}
