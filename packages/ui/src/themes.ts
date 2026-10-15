/**
 * Theme registry, token contract and the CSS-injection helpers shared by the
 * server renderer and the admin theme editor.
 *
 * Why this is TypeScript and not only CSS: the server inlines the owner's token
 * overrides into the document head before first paint, so the values have to be
 * validated in exactly one place before they can reach a stylesheet. Keeping the
 * registry here also means the editor gets the preset list and the contrast
 * guardrails from the same module the renderer uses.
 */

export type ThemeName = "cove" | "studio" | "paper" | "midnight";

export interface PresetMeta {
  label: string;
  description: string;
  dataTheme: ThemeName;
  isDark: boolean;
}

export const PRESETS: Record<ThemeName, PresetMeta> = {
  cove: {
    label: "Cove",
    description: "Warm charcoal, ember accent, serif display. The default.",
    dataTheme: "cove",
    isDark: true,
  },
  studio: {
    label: "Studio",
    description: "Neutral graphite, cool accent, tight radii, no grain.",
    dataTheme: "studio",
    isDark: true,
  },
  paper: {
    label: "Paper",
    description: "Warm off-white, editorial, high-contrast ink.",
    dataTheme: "paper",
    isDark: false,
  },
  midnight: {
    label: "Midnight",
    description: "Deep blue-black, cool indigo accent, generous radii.",
    dataTheme: "midnight",
    isDark: true,
  },
};

export const THEME_NAMES: readonly ThemeName[] = ["cove", "studio", "paper", "midnight"];

export const DEFAULT_THEME: ThemeName = "cove";

export type ThemeDensity = "comfortable" | "compact";
export type ThemeMode = "dark" | "light" | "auto";
export type ThemeCardStyle = "flat" | "soft" | "lifted";

/** Explicit corner radii. The editor exposes the three values directly. */
export interface ThemeRadius {
  sm: string;
  md: string;
  lg: string;
}

/**
 * The overridable knobs the admin theme editor exposes. Every field is optional
 * when passed in; a stored theme is a `Partial<ThemeTokens>` JSON object.
 */
export interface ThemeTokens {
  accent: string;
  accentSoft: string;
  accentInk: string;
  radius: ThemeRadius;
  density: ThemeDensity;
  mode: ThemeMode;
  /** 0–0.06. Values outside the range are clamped, not rejected. */
  grain: number;
  cardStyle: ThemeCardStyle;
  fontDisplay: string;
}

/* ── Colour maths ─────────────────────────────────────────────────────────── */

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const INK_DARK = "#1a0f0a";
const INK_LIGHT = "#fff8f4";

function hexToRgb(hex: string): readonly [number, number, number] | null {
  if (!HEX_PATTERN.test(hex)) return null;
  let body = hex.slice(1);
  if (body.length === 3) {
    body = body
      .split("")
      .map((part) => part + part)
      .join("");
  }
  // #rrggbbaa: alpha is ignored, contrast is measured against an opaque backdrop.
  if (body.length === 8) body = body.slice(0, 6);
  const value = Number.parseInt(body, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * linearize(rgb[0]) + 0.7152 * linearize(rgb[1]) + 0.0722 * linearize(rgb[2]);
}

/**
 * WCAG 2.1 contrast ratio, 1–21. Invalid hex input returns 1, i.e. "unknown,
 * assume worst case" — the editor then refuses to save rather than trusting it.
 */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (a === null || b === null) return 1;
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Pick the readable text colour for a solid background, chosen from the two ink
 * tones the palette already uses. Invalid input falls back to the dark ink,
 * which is what the default ember accent needs.
 */
export function suggestReadableInk(bg: string): string {
  if (hexToRgb(bg) === null) return INK_DARK;
  return contrastRatio(bg, INK_DARK) >= contrastRatio(bg, INK_LIGHT) ? INK_DARK : INK_LIGHT;
}

/* ── Token → CSS ──────────────────────────────────────────────────────────── */

/**
 * A token value may never be "clever". Anything that could terminate the
 * declaration, the rule or the surrounding <style> element is dropped rather
 * than escaped, which keeps this helper safe regardless of how the value got
 * into the database.
 */
const UNSAFE_VALUE = /[;}<]|url\(/i;

function safeValue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return null;
  if (UNSAFE_VALUE.test(trimmed)) return null;
  return trimmed.replace(/[\r\n]+/g, " ");
}

function pushDeclaration(
  declarations: string[],
  property: string,
  value: unknown,
): void {
  if (typeof value !== "string") return;
  const safe = safeValue(value);
  if (safe === null) return;
  declarations.push(`${property}:${safe}`);
}

/** Density is expressed as the spacing scale plus the card padding. */
function densityDeclarations(density: ThemeDensity): readonly string[] {
  if (density === "compact") {
    return [
      "--space-1:2px",
      "--space-2:6px",
      "--space-3:8px",
      "--space-4:12px",
      "--space-5:16px",
      "--space-6:24px",
      "--space-7:32px",
      "--space-8:48px",
      "--card-pad-block:10px",
      "--card-pad-inline:12px",
      "--card-pad-bottom:12px",
    ];
  }
  return [
    "--space-1:4px",
    "--space-2:8px",
    "--space-3:12px",
    "--space-4:16px",
    "--space-5:24px",
    "--space-6:32px",
    "--space-7:48px",
    "--space-8:64px",
    "--card-pad-block:14px",
    "--card-pad-inline:15px",
    "--card-pad-bottom:16px",
  ];
}

function cardStyleDeclarations(cardStyle: ThemeCardStyle): readonly string[] {
  switch (cardStyle) {
    case "flat":
      return ["--card-shadow:none", "--card-shadow-hover:none", "--card-lift:0px"];
    case "lifted":
      return [
        "--card-shadow:var(--shadow-1)",
        "--card-shadow-hover:var(--shadow-2)",
        "--card-lift:-6px",
      ];
    case "soft":
      return [
        "--card-shadow:var(--shadow-1)",
        "--card-shadow-hover:var(--shadow-2)",
        "--card-lift:-3px",
      ];
  }
}

function modeDeclarations(mode: ThemeMode): readonly string[] {
  switch (mode) {
    case "dark":
      return ["color-scheme:dark"];
    case "light":
      return ["color-scheme:light"];
    case "auto":
      return ["color-scheme:light dark"];
  }
}

/**
 * Build the declaration list (no selector) for a set of overrides. Used by
 * `tokensToCss` for `:root` and by <ThemeStyle> for `[data-theme="…"]`, which is
 * why the selector is not baked in here.
 */
export function tokensToDeclarations(tokens?: Partial<ThemeTokens>): string {
  if (!tokens) return "";
  const declarations: string[] = [];

  const accent = typeof tokens.accent === "string" ? safeValue(tokens.accent) : null;
  if (accent !== null) declarations.push(`--accent:${accent}`);
  pushDeclaration(declarations, "--accent-soft", tokens.accentSoft);

  const ink = typeof tokens.accentInk === "string" ? safeValue(tokens.accentInk) : null;
  if (ink !== null) {
    declarations.push(`--accent-ink:${ink}`);
  } else if (accent !== null && HEX_PATTERN.test(accent)) {
    // Contrast guardrail (PLAN §5): an unreadable accent/ink pair is corrected
    // here instead of being silently shipped. Only hex accents can be measured.
    declarations.push(`--accent-ink:${suggestReadableInk(accent)}`);
  }

  if (tokens.radius) {
    pushDeclaration(declarations, "--r-sm", tokens.radius.sm);
    pushDeclaration(declarations, "--r-md", tokens.radius.md);
    pushDeclaration(declarations, "--r-lg", tokens.radius.lg);
  }

  if (tokens.density) declarations.push(...densityDeclarations(tokens.density));
  if (tokens.cardStyle) declarations.push(...cardStyleDeclarations(tokens.cardStyle));
  if (tokens.mode) declarations.push(...modeDeclarations(tokens.mode));
  pushDeclaration(declarations, "--font-display", tokens.fontDisplay);

  if (typeof tokens.grain === "number" && Number.isFinite(tokens.grain)) {
    // Clamp rather than drop: 0 means "off" and the editor slider tops out at .06.
    const grain = Math.min(0.06, Math.max(0, tokens.grain));
    declarations.push(`--grain:${Number(grain.toFixed(3))}`);
  }

  return declarations.join(";");
}

/**
 * `:root{…}` override string for inlining into <head>. Empty token sets produce
 * an empty string so callers can skip emitting a <style> element at all.
 */
export function tokensToCss(tokens: Partial<ThemeTokens>): string {
  const declarations = tokensToDeclarations(tokens);
  return declarations.length === 0 ? "" : `:root{${declarations}}`;
}
