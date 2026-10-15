export {
  closeDb,
  getDb,
  getPool,
  ping,
  runMigrations,
  schema,
  type Database,
  type DbOptions,
} from "./client.js";

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
} from "./settings.js";

export * from "./schema.js";
