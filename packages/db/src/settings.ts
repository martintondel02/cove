/**
 * Site settings: theming, branding and feature flags.
 *
 * Stored as key/jsonb rather than columns because the theme editor alone has a
 * dozen knobs, and every new one would otherwise mean a schema migration.
 *
 * Reads are fallback-tolerant on purpose: a fresh install has no rows at all,
 * and the first page render must still work. So `getSettings` merges the
 * defaults underneath whatever is in the database, and a value that fails
 * validation falls back rather than crashing the render (federation seam #? —
 * see `resolveTheme` in the web app for the validation step).
 */
import { inArray } from "drizzle-orm";

import { getDb, type Database } from "./client";
import { siteSettings } from "./schema";

/** Every setting key Cove understands. */
export const SETTING_KEYS = {
  siteName: "site.name",
  siteTagline: "site.tagline",
  siteVisibility: "site.visibility",
  themePreset: "theme.preset",
  themeTokens: "theme.tokens",
  federationEnabled: "federation.enabled",
  federationAllowReplies: "federation.allowReplies",
  onboardingComplete: "onboarding.complete",
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/**
 * Defaults are written so that a bare `compose up` immediately produces a
 * finished-looking site with no configuration at all — the "working defaults
 * everywhere" rule from docs/PLAN.md §9.
 */
export const DEFAULT_SETTINGS: Record<SettingKey, unknown> = {
  [SETTING_KEYS.siteName]: "Cove",
  [SETTING_KEYS.siteTagline]: "A quiet corner of the internet.",
  [SETTING_KEYS.siteVisibility]: "public",
  [SETTING_KEYS.themePreset]: "cove",
  [SETTING_KEYS.themeTokens]: {},
  [SETTING_KEYS.federationEnabled]: false,
  [SETTING_KEYS.federationAllowReplies]: false,
  [SETTING_KEYS.onboardingComplete]: false,
};

export type SettingsMap = Record<string, unknown>;

/** Read a set of settings, with defaults merged underneath. */
export async function getSettings(
  keys: readonly SettingKey[],
  db: Database = getDb(),
): Promise<SettingsMap> {
  const result: SettingsMap = {};
  for (const key of keys) result[key] = DEFAULT_SETTINGS[key];

  if (keys.length === 0) return result;

  const rows = await db
    .select()
    .from(siteSettings)
    .where(inArray(siteSettings.key, [...keys]));

  for (const row of rows) {
    // A stored null means "unset" — keep the default rather than serving null.
    if (row.value !== null && row.value !== undefined) result[row.key] = row.value;
  }
  return result;
}

/** Read one setting, with its default applied. */
export async function getSetting<T = unknown>(
  key: SettingKey,
  db: Database = getDb(),
): Promise<T> {
  const map = await getSettings([key], db);
  return map[key] as T;
}

/** Write one setting. Idempotent upsert. */
export async function setSetting(
  key: SettingKey,
  value: unknown,
  db: Database = getDb(),
): Promise<void> {
  await db
    .insert(siteSettings)
    .values({ key, value: value ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { value: value ?? null, updatedAt: new Date() },
    });
}

/** Write many settings in sequence. Fine at this scale (a handful of rows). */
export async function setSettings(
  entries: Partial<Record<SettingKey, unknown>>,
  db: Database = getDb(),
): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    await setSetting(key as SettingKey, value, db);
  }
}

/** Seed the defaults for any key that has no row yet. Safe to call on boot. */
export async function ensureDefaultSettings(db: Database = getDb()): Promise<void> {
  const keys = Object.values(SETTING_KEYS);
  const existing = await db.select().from(siteSettings).where(inArray(siteSettings.key, keys));
  const present = new Set(existing.map((row) => row.key));

  const missing = keys.filter((key) => !present.has(key));
  if (missing.length === 0) return;

  await db
    .insert(siteSettings)
    .values(missing.map((key) => ({ key, value: DEFAULT_SETTINGS[key] ?? null })))
    .onConflictDoNothing();
}
