/**
 * Loads everything a page needs: configuration, stored settings and the owner
 * actor — and, critically, **never throws**.
 *
 * A personal site that shows a blank 500 because Postgres is down is a bad
 * site. Every failure mode here resolves to a rendered explanation with a fix,
 * which is also what makes the Phase 0 build work in CI with no database at all.
 *
 * Seeding (migrations, default settings, the owner actor) happens once in
 * `instrumentation.ts`, not here — this path is read-only so a page render can
 * never write to the database.
 */
import {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  detectIdentityDrift,
  getActorByHandle,
  getSettings,
  type Actor,
} from "@cove/db";
import { isVisibility, type Visibility } from "@cove/shared";
import { DEFAULT_THEME, THEME_NAMES, type ThemeName, type ThemeTokens } from "@cove/ui";

import { getEnvState } from "./env";

export interface SiteProblem {
  readonly title: string;
  readonly detail: string;
  readonly hints: readonly string[];
}

export interface SiteContext {
  readonly configured: boolean;
  readonly siteName: string;
  readonly siteTagline: string;
  readonly siteUrl: string;
  readonly handle: string;
  readonly preset: ThemeName;
  readonly tokens: Partial<ThemeTokens>;
  readonly visibility: Visibility;
  readonly actor: Actor | null;
  /** Set when the stored identity disagrees with COVE_SITE_URL. */
  readonly identityDrift: string | null;
  readonly problem: SiteProblem | null;
}

const DENSITIES = ["comfortable", "compact"] as const;
const MODES = ["dark", "light", "auto"] as const;
const CARD_STYLES = ["flat", "soft", "lifted"] as const;

function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Coerce whatever JSON is in `theme.tokens` into a valid `Partial<ThemeTokens>`.
 *
 * `tokensToCss` already refuses to emit unsafe declarations, so this is defence
 * in depth — but it also keeps the *types* honest, which matters because a
 * malformed stored value should degrade to the preset, not to a broken page.
 */
export function sanitizeThemeTokens(raw: unknown): Partial<ThemeTokens> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const tokens: Partial<ThemeTokens> = {};

  const accent = asString(source.accent);
  if (accent) tokens.accent = accent;
  const accentSoft = asString(source.accentSoft);
  if (accentSoft) tokens.accentSoft = accentSoft;
  const accentInk = asString(source.accentInk);
  if (accentInk) tokens.accentInk = accentInk;

  const radius = source.radius;
  if (typeof radius === "object" && radius !== null) {
    const r = radius as Record<string, unknown>;
    const sm = asString(r.sm);
    const md = asString(r.md);
    const lg = asString(r.lg);
    if (sm || md || lg) {
      tokens.radius = {
        sm: sm ?? "10px",
        md: md ?? "16px",
        lg: lg ?? "24px",
      };
    }
  }

  const density = asEnum(source.density, DENSITIES);
  if (density) tokens.density = density;
  const mode = asEnum(source.mode, MODES);
  if (mode) tokens.mode = mode;
  const cardStyle = asEnum(source.cardStyle, CARD_STYLES);
  if (cardStyle) tokens.cardStyle = cardStyle;

  if (typeof source.grain === "number" && Number.isFinite(source.grain)) {
    tokens.grain = Math.min(0.06, Math.max(0, source.grain));
  }

  const fontDisplay = asString(source.fontDisplay);
  if (fontDisplay) tokens.fontDisplay = fontDisplay;

  return tokens;
}

/** The fallback context used when configuration itself is missing. */
function unconfiguredContext(problem: SiteProblem): SiteContext {
  return {
    configured: false,
    siteName: String(DEFAULT_SETTINGS[SETTING_KEYS.siteName] ?? "Cove"),
    siteTagline: String(DEFAULT_SETTINGS[SETTING_KEYS.siteTagline] ?? ""),
    siteUrl: "",
    handle: "",
    preset: DEFAULT_THEME,
    tokens: {},
    visibility: "public",
    actor: null,
    identityDrift: null,
    problem,
  };
}

export async function loadSiteContext(): Promise<SiteContext> {
  const envState = getEnvState();

  if (!envState.ok) {
    return unconfiguredContext({
      title: "Cove is not configured yet",
      detail: envState.error,
      hints: [
        "Run ./setup.sh — it writes a .env with real secrets.",
        envState.missing.length > 0
          ? `Missing right now: ${envState.missing.join(", ")}`
          : "Check the values listed above.",
      ],
    });
  }

  const env = envState.env;

  const base = {
    configured: true,
    siteUrl: env.siteUrl,
    handle: env.handle,
    actor: null,
    identityDrift: null,
    problem: null,
  } as const;

  try {
    const settings = await getSettings([
      SETTING_KEYS.siteName,
      SETTING_KEYS.siteTagline,
      SETTING_KEYS.siteVisibility,
      SETTING_KEYS.themePreset,
      SETTING_KEYS.themeTokens,
    ]);

    const actor = (await getActorByHandle(env.handle)) ?? null;

    // Read once into locals: the type guards below cannot narrow a repeated
    // index expression, so `settings[key]` twice would not typecheck.
    const presetRaw = settings[SETTING_KEYS.themePreset];
    const visibilityRaw = settings[SETTING_KEYS.siteVisibility];

    return {
      ...base,
      siteName: asString(settings[SETTING_KEYS.siteName]) ?? env.siteName,
      siteTagline: asString(settings[SETTING_KEYS.siteTagline]) ?? env.siteTagline,
      preset: isThemeName(presetRaw) ? presetRaw : DEFAULT_THEME,
      tokens: sanitizeThemeTokens(settings[SETTING_KEYS.themeTokens]),
      visibility: isVisibility(visibilityRaw) ? visibilityRaw : env.visibility,
      actor,
      identityDrift: actor ? detectIdentityDrift(actor, env.siteUrl) : null,
    };
  } catch (error) {
    // The most common first-run failure by far, so it gets a purpose-built
    // explanation rather than a generic error.
    return {
      ...base,
      siteName: env.siteName,
      siteTagline: env.siteTagline,
      preset: DEFAULT_THEME,
      tokens: {},
      visibility: env.visibility,
      problem: {
        title: "Cove cannot reach its database",
        detail: (error as Error).message,
        hints: [
          "Is the database running?  podman compose ps",
          "Check the logs:          podman compose logs db",
          "Verify DATABASE_URL in .env points at the db service.",
          "Run ./scripts/doctor.sh for a full preflight.",
        ],
      },
    };
  }
}
