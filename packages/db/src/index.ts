export {
  closeDb,
  getDb,
  getPool,
  ping,
  runMigrations,
  schema,
  type Database,
  type DbOptions,
} from "./client";

export {
  detectIdentityDrift,
  ensureOwnerActor,
  getActorByHandle,
  type OwnerActorInput,
} from "./actors";

export {
  countFederatedPosts,
  getPostBySlug,
  listFederatedPosts,
} from "./posts";

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
} from "./settings";

export * from "./schema";
