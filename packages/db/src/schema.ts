/**
 * Cove's schema. See docs/PLAN.md §8 for the reasoning behind the shape.
 *
 * Two structural decisions are load-bearing:
 *
 *  1. `posts` is the polymorphic spine. Video, live, photo, reel and album are
 *     one table with one `kind`, so the home feed is a single ordered query and
 *     the media pipelines share one publishing path.
 *  2. The federation seams are in the schema from the first migration, not
 *     bolted on later. Every actor and post carries a canonical `uri`; nothing
 *     is ever hard-deleted; and `visibility` has exactly three values, each of
 *     which maps onto an ActivityStreams audience (packages/shared/visibility).
 */
import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ────────────────────────────── enums ────────────────────────────── */

export const postKindEnum = pgEnum("post_kind", ["video", "live", "photo", "reel", "album"]);

/**
 * Federation seam #5. Keep this list tiny: every value must be expressible as
 * an AS2 audience. `public` → Public collection, `unlisted` → followers +
 * Public-in-cc, `private` → never federated.
 */
export const visibilityEnum = pgEnum("visibility", ["public", "unlisted", "private"]);

export const actorRoleEnum = pgEnum("actor_role", ["owner", "collaborator"]);
export const credentialKindEnum = pgEnum("credential_kind", ["passkey", "password", "totp"]);
export const mediaRoleEnum = pgEnum("media_role", [
  "source",
  "poster",
  "thumb",
  "hls",
  "sprite",
  "photo",
  "avatar",
  "caption",
]);
export const collectionKindEnum = pgEnum("collection_kind", ["playlist", "watch_later"]);
export const jobStateEnum = pgEnum("job_state", [
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
]);

/* ──────────────────────── identity & settings ────────────────────── */

/**
 * One actor today, but modelled as an actor from the first commit rather than
 * as "the user". A federated identity is an actor with an inbox and an outbox;
 * making that true now means adding a collaborator later is an INSERT, not a
 * migration of every URI that remote servers already know.
 */
export const actors = pgTable(
  "actors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    handle: text("handle").notNull(),
    displayName: text("display_name").notNull(),
    bio: text("bio"),
    role: actorRoleEnum("role").notNull().default("owner"),

    // ── Federation seam #1: minted once, never renumbered. ──
    uri: text("uri").notNull(),
    inboxUri: text("inbox_uri").notNull(),
    outboxUri: text("outbox_uri").notNull(),
    followersUri: text("followers_uri").notNull(),

    avatarMediaId: uuid("avatar_media_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("actors_handle_key").on(table.handle),
    uniqueIndex("actors_uri_key").on(table.uri),
  ],
);

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    kind: credentialKindEnum("kind").notNull(),
    /** Opaque per-kind payload: a hashed password, a passkey public key, a TOTP secret. */
    secret: text("secret").notNull(),
    label: text("label"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("credentials_actor_idx").on(table.actorId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("sessions_actor_idx").on(table.actorId)],
);

/**
 * Site configuration as key/jsonb. Deliberately schemaless: theming alone has
 * a dozen knobs, and putting them in columns would mean a migration every time
 * the theme editor gains a setting.
 */
export const siteSettings = pgTable("site_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/* ───────────────────────────── content ───────────────────────────── */

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => actors.id, { onDelete: "restrict" }),
    kind: postKindEnum("kind").notNull(),
    slug: text("slug").notNull(),

    // ── Federation seam #1: the permanent, dereferenceable identity of this post. ──
    uri: text("uri").notNull(),

    title: text("title").notNull(),
    /** Markdown-ish body text. */
    body: text("body"),
    /** Alt text for the primary media — accessibility, and it feeds search. */
    altText: text("alt_text"),

    // ── Federation seam #5. ──
    visibility: visibilityEnum("visibility").notNull().default("public"),

    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * ── Federation seam #4: tombstones. ──
     * A federated object is never hard-deleted. The row and its URI survive so
     * that a remote server which still holds a copy can be told the object is
     * gone (HTTP 410 + an AS2 `Tombstone`) instead of silently serving a stale
     * one. Queries filter on `deleted_at IS NULL`.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("posts_slug_key").on(table.slug),
    uniqueIndex("posts_uri_key").on(table.uri),
    index("posts_feed_idx").on(table.publishedAt, table.deletedAt),
    index("posts_author_idx").on(table.authorId),
  ],
);

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    role: mediaRoleEnum("role").notNull(),

    /** Path relative to COVE_DATA_DIR — never an absolute host path. */
    path: text("path").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes"),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),

    /** Tiny inline placeholder so every image slot has content on first paint. */
    thumbhash: text("thumbhash"),
    /** Ambient backdrop colour, extracted from the media itself. */
    dominantColor: text("dominant_color"),
    /** Generated derivatives: { avif: [...], webp: [...], jpeg: [...] }. */
    variants: jsonb("variants").$type<Record<string, unknown>>(),
    /** Sanitised EXIF subset — no GPS, applied orientation folded in. */
    exif: jsonb("exif").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("media_post_idx").on(table.postId),
    index("media_role_idx").on(table.postId, table.role),
  ],
);

export const videos = pgTable("videos", {
  postId: uuid("post_id")
    .primaryKey()
    .references(() => posts.id, { onDelete: "cascade" }),
  masterPlaylist: text("master_playlist"),
  renditions: jsonb("renditions").$type<unknown[]>(),
  captions: jsonb("captions").$type<unknown[]>(),
  chapters: jsonb("chapters").$type<unknown[]>(),
  /** Set when the pipeline decided not to re-encode. */
  remuxOnly: boolean("remux_only").notNull().default(false),
});

export const photos = pgTable("photos", {
  postId: uuid("post_id")
    .primaryKey()
    .references(() => posts.id, { onDelete: "cascade" }),
  aspect: text("aspect"),
  takenAt: timestamp("taken_at", { withTimezone: true }),
  camera: jsonb("camera").$type<Record<string, unknown>>(),
});

export const albums = pgTable("albums", {
  postId: uuid("post_id")
    .primaryKey()
    .references(() => posts.id, { onDelete: "cascade" }),
  coverMediaId: uuid("cover_media_id"),
});

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
  },
  (table) => [uniqueIndex("tags_slug_key").on(table.slug)],
);

export const postTags = pgTable(
  "post_tags",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.postId, table.tagId] })],
);

export const collections = pgTable("collections", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id")
    .notNull()
    .references(() => actors.id, { onDelete: "cascade" }),
  kind: collectionKindEnum("kind").notNull().default("playlist"),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const collectionItems = pgTable(
  "collection_items",
  {
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.collectionId, table.postId] })],
);

/* ───────────────────── transcoding job bookkeeping ───────────────── */

/**
 * This is Cove's own view of a media job — the durable state machine the UI
 * reads. pg-boss owns *scheduling* (retries, backoff, locking) in its own
 * schema; this table exists so the admin UI can show progress without
 * introspecting pg-boss internals, and so a job can hold artifacts and errors.
 */
export const mediaJobs = pgTable(
  "media_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    state: jobStateEnum("state").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    progress: integer("progress").notNull().default(0),
    /** Working directory is `<data>/work/<id>`; outputs are renamed into place. */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    error: text("error"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("media_jobs_state_idx").on(table.state, table.createdAt)],
);

/* ──────────────────────────── live ──────────────────────────────── */

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** Only ever the hash — the plaintext key is shown to the owner exactly once. */
    streamKeyHash: text("stream_key_hash").notNull(),
    record: boolean("record").notNull().default(true),
    retentionDays: integer("retention_days"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("channels_slug_key").on(table.slug)],
);

export const streams = pgTable(
  "streams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    peakViewers: integer("peak_viewers").notNull().default(0),
    recordingPath: text("recording_path"),
    /** The VOD this livestream became once it ended. */
    postId: uuid("post_id").references(() => posts.id, { onDelete: "set null" }),
  },
  (table) => [index("streams_channel_idx").on(table.channelId, table.startedAt)],
);

/**
 * Moderation state only. Chat is ephemeral *by construction*: message text
 * lives in an in-memory ring buffer with a TTL and is never written here, which
 * makes "chat that vanishes" the default rather than a setting someone forgets.
 */
export const chatBans = pgTable(
  "chat_bans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** A hashed viewer fingerprint — we never need a real identity to mute. */
    subjectHash: text("subject_hash").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("chat_bans_key").on(table.channelId, table.subjectHash)],
);

/* ───────────────────────── engagement ───────────────────────────── */

/**
 * Owner-visible stats only — there is no third-party analytics anywhere in
 * Cove. `sessionHash` is a salted hash, never a raw IP, and rows are purged on
 * a rolling window by default.
 */
export const viewEvents = pgTable(
  "view_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    sessionHash: text("session_hash").notNull(),
    secondsWatched: integer("seconds_watched").notNull().default(0),
    quality: text("quality"),
    referrer: text("referrer"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("view_events_post_idx").on(table.postId, table.at)],
);

/* ────────────────────────── relations ───────────────────────────── */

export const actorsRelations = relations(actors, ({ many }) => ({
  posts: many(posts),
  credentials: many(credentials),
  channels: many(channels),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(actors, { fields: [posts.authorId], references: [actors.id] }),
  media: many(mediaAssets),
  video: one(videos, { fields: [posts.id], references: [videos.postId] }),
  photo: one(photos, { fields: [posts.id], references: [photos.postId] }),
}));

export const mediaAssetsRelations = relations(mediaAssets, ({ one }) => ({
  post: one(posts, { fields: [mediaAssets.postId], references: [posts.id] }),
}));

/* ───────────────────────── inferred types ───────────────────────── */

export type Actor = typeof actors.$inferSelect;
export type NewActor = typeof actors.$inferInsert;
export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type NewMediaAsset = typeof mediaAssets.$inferInsert;
export type MediaJob = typeof mediaJobs.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type SiteSetting = typeof siteSettings.$inferSelect;
