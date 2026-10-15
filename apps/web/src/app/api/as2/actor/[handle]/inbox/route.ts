/**
 * The inbox — where remote servers would POST activities addressed to us.
 *
 * Deliberately not implemented, and the refusal is explicit rather than a
 * generic 404. Cove's federation posture is **broadcast-first**: we push posts
 * out, we do not ingest a firehose. That is a moderation decision, not a
 * technical gap — the moment this endpoint accepts activities, the owner owns
 * moderating whatever arrives.
 *
 * Phase 5 wires Fedify's interaction controls here behind
 * `COVE_FEDERATION_ALLOW_REPLIES`.
 */
import { loadFederationContext } from "@/lib/federation/context";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ handle: string }> },
): Promise<Response> {
  const { handle } = await context.params;
  const lookup = await loadFederationContext(handle);
  if (!lookup.ok) return lookup.response;

  const { env } = lookup.context;

  if (!env.federationEnabled) {
    return Response.json(
      {
        error: "This instance does not accept inbound federation activities.",
        hint: "Outbound federation only (broadcast-first). Set COVE_FEDERATION_ENABLED=true to opt in.",
      },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }

  if (!env.federationAllowReplies) {
    return Response.json(
      {
        error: "Inbound replies are disabled.",
        hint: "Set COVE_FEDERATION_ALLOW_REPLIES=true to accept them, and expect to moderate them.",
      },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }

  // Enabled, but the delivery pipeline arrives with Fedify in Phase 5.
  // 501 is the honest answer; pretending to accept would silently drop
  // activities and break remote servers' retry logic in confusing ways.
  return Response.json(
    {
      error: "Inbound federation is enabled but not implemented yet.",
      hint: "Planned for Phase 5 (Fedify). See docs/PLAN.md §6.5.",
    },
    { status: 501, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(): Promise<Response> {
  return Response.json(
    { error: "The inbox accepts POSTed activities only (ActivityPub S2S)." },
    { status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
  );
}
