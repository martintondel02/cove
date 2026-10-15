/**
 * Actor bootstrap.
 *
 * Cove is single-tenant, but it is modelled as an *actor* from the first
 * commit rather than as "the user", and the owner actor is created on first
 * boot from the environment. Two reasons:
 *
 *  1. A federated identity is an actor with an inbox and an outbox. Creating
 *     that on first boot means `@me@domain` resolves immediately, before any
 *     content exists.
 *  2. Adding a collaborator later becomes an INSERT rather than a change to the
 *     routing surface that remote servers already know.
 *
 * The URIs are derived from `COVE_SITE_URL` and `COVE_HANDLE` via
 * `@cove/shared`, so they can never be constructed ad-hoc somewhere else.
 */
import {
  actorFollowersUri,
  actorInboxUri,
  actorOutboxUri,
  actorUri,
} from "@cove/shared";
import { eq } from "drizzle-orm";

import { getDb, type Database } from "./client.ts";
import { actors, type Actor } from "./schema.ts";

export interface OwnerActorInput {
  readonly siteUrl: string;
  readonly handle: string;
  readonly displayName: string;
}

/**
 * Return the owner actor, creating it if it does not exist yet.
 *
 * Idempotent, and safe to call on every boot. If the actor already exists we
 * deliberately do NOT rewrite its `uri`: a federated identity is a URL, and
 * changing it would orphan every remote copy. Changing the site URL or handle
 * after the fact is a migration, not a config edit.
 */
export async function ensureOwnerActor(
  input: OwnerActorInput,
  db: Database = getDb(),
): Promise<Actor> {
  const existing = await db
    .select()
    .from(actors)
    .where(eq(actors.handle, input.handle))
    .limit(1);

  const found = existing[0];
  if (found) return found;

  const inserted = await db
    .insert(actors)
    .values({
      handle: input.handle,
      displayName: input.displayName,
      role: "owner",
      uri: actorUri(input.siteUrl, input.handle),
      inboxUri: actorInboxUri(input.siteUrl, input.handle),
      outboxUri: actorOutboxUri(input.siteUrl, input.handle),
      followersUri: actorFollowersUri(input.siteUrl, input.handle),
    })
    .onConflictDoNothing({ target: actors.handle })
    .returning();

  const created = inserted[0];
  if (created) return created;

  // Lost a race with another boot process — read it back.
  const again = await db
    .select()
    .from(actors)
    .where(eq(actors.handle, input.handle))
    .limit(1);

  const raced = again[0];
  if (!raced) {
    throw new Error(
      `Could not create or find the owner actor for handle "${input.handle}".`,
    );
  }
  return raced;
}

/** Look up an actor by handle. Used by the WebFinger and AS2 endpoints. */
export async function getActorByHandle(
  handle: string,
  db: Database = getDb(),
): Promise<Actor | undefined> {
  const rows = await db.select().from(actors).where(eq(actors.handle, handle)).limit(1);
  return rows[0];
}

/**
 * Detect a mismatch between the stored actor identity and the current
 * configuration. This is worth surfacing loudly: it means the site URL or
 * handle changed after the actor was created, which silently breaks federation.
 */
export function detectIdentityDrift(actor: Actor, siteUrl: string): string | null {
  const expected = actorUri(siteUrl, actor.handle);
  if (actor.uri !== expected) {
    return (
      `This instance was set up as ${actor.uri}, but COVE_SITE_URL now points at ${expected}. ` +
      `Federated identities are permanent URLs, so remote servers will keep using the old one. ` +
      `Restore the original COVE_SITE_URL to avoid breaking followers.`
    );
  }
  return null;
}
