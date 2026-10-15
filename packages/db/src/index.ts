export {
  closeDb,
  getDb,
  getPool,
  ping,
  runMigrations,
  schema,
  type Database,
  type DbOptions,
} from "./client.ts";

export {
  detectIdentityDrift,
  ensureOwnerActor,
  getActorByHandle,
  type OwnerActorInput,
} from "./actors.ts";

export {
  deletePostById,
  findViewablePostId,
  insertPost,
  slugExists,
  type InsertPostInput,
} from "./posts.ts";

export {
  countFederatedPosts,
  getPostBySlug,
  getPublishedVideoBySlug,
  listFederatedPosts,
  listPublishedVideos,
  type PublishedVideo,
} from "./posts.ts";

export {
  createMediaJob,
  findLatestJobForPost,
  listUnpublishedPosts,
  publishVideo,
  requeueStaleJobs,
  updateMediaJob,
  type CreateJobInput,
  type JobState,
  type PublishAsset,
  type PublishVideoInput,
  type UpdateJobInput,
} from "./media-jobs.ts";

export {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  ensureDefaultSettings,
  getSetting,
  getSettings,
  setSetting,
  setSettings,
  type SettingKey,
  type SettingsMap,
} from "./settings.ts";

export * from "./schema.ts";
