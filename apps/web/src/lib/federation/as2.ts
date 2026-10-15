/**
 * ActivityStreams 2.0 object builders.
 *
 * Hand-written rather than pulled from a library, because the four objects Cove
 * needs (Person, a content object, a collection, a Tombstone) are small and
 * well-specified — and because Phase 5 will replace the *delivery* half with
 * Fedify while these builders remain the vocabulary layer.
 *
 * Every URI in here comes from `@cove/shared`, so the identifiers that remote
 * servers cache are guaranteed to match the ones the database stores.
 */
import { postUri, slugify, visibilityToAudience } from "@cove/shared";
// Type-only import: `Actor` and `Post` are database row types, so this must not
// pull the Postgres driver into modules that only need the shapes. `import type`
// is erased at compile time.
import type { Actor, Post } from "@cove/db";

import { AS2_CONTENT_TYPE, negotiatedHeaders } from "./accept";

/** The AS2 context, plus the security vocabulary used by the public key. */
const CONTEXT = [
  "https://www.w3.org/ns/activitystreams",
  "https://w3id.org/security/v1",
] as const;

/**
 * Serialise an ActivityStreams object as a response.
 *
 * Lives here rather than in `accept.ts` so that module stays pure negotiation
 * logic with no notion of a response body.
 */
export function as2Response(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      ...negotiatedHeaders(AS2_CONTENT_TYPE),
      // Federation objects are cheap to compute and change rarely; a short
      // cache spares remote servers a stampede without risking staleness.
      "cache-control": "public, max-age=60",
      ...(init?.headers ?? {}),
    },
  });
}

export interface PersonOptions {
  readonly siteUrl: string;
  /** Present once Phase 5 generates a keypair for HTTP signatures. */
  readonly publicKeyPem?: string;
  readonly avatarUrl?: string;
  readonly federationEnabled?: boolean;
}

/**
 * The actor document: the single URL that identifies this person to the
 * fediverse. Served at `/@handle` under content negotiation.
 */
export function buildPerson(actor: Actor, options: PersonOptions): Record<string, unknown> {
  const person: Record<string, unknown> = {
    "@context": CONTEXT,
    id: actor.uri,
    type: "Person",
    preferredUsername: actor.handle,
    name: actor.displayName,
    // `url` points at the human page; `id` is the machine identity. They are
    // the same URL here, which is the simplest thing that can work.
    url: actor.uri,
    inbox: actor.inboxUri,
    outbox: actor.outboxUri,
    followers: actor.followersUri,
    // Declared so remote servers know the shape of what we send.
    attachment: [],
    published: actor.createdAt.toISOString(),
  };

  if (actor.bio) person.summary = actor.bio;

  if (options.avatarUrl) {
    person.icon = {
      type: "Image",
      mediaType: "image/webp",
      url: options.avatarUrl,
    };
  }

  // HTTP signatures are how the fediverse proves a delivery came from us.
  // Without a key, remote servers will fetch the actor but reject deliveries,
  // so this is the one thing Phase 5 must add before federation is switched on.
  if (options.publicKeyPem) {
    person.publicKey = {
      id: `${actor.uri}#main-key`,
      owner: actor.uri,
      publicKeyPem: options.publicKeyPem,
    };
  }

  return person;
}

export interface PostOptions {
  readonly siteUrl: string;
  /** The author's canonical actor URI. AS2 requires a URL here, not an id. */
  readonly actorUri: string;
  readonly followersUri: string;
  /** Absolute URL of the poster frame, if the post has media. */
  readonly posterUrl?: string;
  readonly durationSeconds?: number;
}

/**
 * A published post, as the fediverse sees it.
 *
 * Video and live become `Video` (the type PeerTube uses, which Mastodon renders
 * with a play affordance); photo, reel and album become `Note` with an Image
 * attachment.
 *
 * Returns `null` for anything that must not federate, so the caller is forced to
 * handle `private` explicitly rather than publishing it by omission.
 */
export function buildPostObject(
  post: Post,
  options: PostOptions,
): Record<string, unknown> | null {
  if (post.deletedAt) return buildTombstone(post.uri, post.deletedAt);

  const audience = visibilityToAudience(post.visibility, options.followersUri);
  if (audience === null) return null;

  const isVideo = post.kind === "video" || post.kind === "live";
  const canonical = post.uri || postUri(options.siteUrl, post.slug);

  const object: Record<string, unknown> = {
    "@context": CONTEXT,
    id: canonical,
    type: isVideo ? "Video" : "Note",
    name: post.title,
    content: post.body ?? "",
    // `sensitive` is deliberately not set: Cove is a personal site, and the
    // owner's own content is not presumed sensitive.
    published: (post.publishedAt ?? post.createdAt).toISOString(),
    url: canonical,
    attributedTo: options.actorUri,
    // The audience split is what decides whether Mastodon shows this in public
    // timelines (`AS_PUBLIC` in `to`) or only to people with the link (in `cc`).
    to: [...audience.to],
    cc: [...audience.cc],
  };

  if (options.posterUrl) {
    object.icon = { type: "Image", mediaType: "image/webp", url: options.posterUrl };
    if (!isVideo) {
      object.attachment = [
        {
          type: "Image",
          mediaType: "image/webp",
          url: options.posterUrl,
          name: post.altText ?? undefined,
        },
      ];
    }
  }

  if (isVideo && typeof options.durationSeconds === "number") {
    // AS2 durations are ISO 8601; a bare number is not a valid duration.
    object.duration = `PT${Math.round(options.durationSeconds)}S`;
  }

  return object;
}

/**
 * A deleted-but-remembered object.
 *
 * Federation seam #4: remote servers that hold a copy are told the object is
 * gone. Returning a Tombstone (rather than 404) is what stops a stale copy
 * being served indefinitely.
 */
export function buildTombstone(uri: string, deletedAt: Date): Record<string, unknown> {
  return {
    "@context": CONTEXT,
    id: uri,
    type: "Tombstone",
    formerType: "Note",
    deleted: deletedAt.toISOString(),
  };
}

export interface OrderedCollectionPage {
  readonly id: string;
  readonly totalItems: number;
  readonly items: readonly unknown[];
}

/**
 * The outbox. Phase 0 returns an OrderedCollection with no items, because
 * nothing can be published yet — but the endpoint exists so the identity is
 * complete and `outbox` in the actor document does not 404.
 */
export function buildOrderedCollection(page: OrderedCollectionPage): Record<string, unknown> {
  return {
    "@context": CONTEXT,
    id: page.id,
    type: "OrderedCollection",
    totalItems: page.totalItems,
    orderedItems: page.items,
  };
}

/** WebFinger response (RFC 7033), seam #3. */
export function buildWebFingerResponse(
  handle: string,
  actorUriValue: string,
  domain: string,
): Record<string, unknown> {
  return {
    subject: `acct:${handle}@${domain}`,
    aliases: [actorUriValue],
    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href: actorUriValue,
      },
      {
        // Lets a browser following the handle land on the human profile.
        rel: "http://webfinger.net/rel/profile-page",
        type: "text/html",
        href: actorUriValue,
      },
    ],
  };
}

/** Slug helper re-exported so route handlers do not each import @cove/shared. */
export { slugify };
