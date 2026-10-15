/**
 * @cove/ui — public surface.
 *
 * The package ships TypeScript source (no build step) and one stylesheet:
 *
 *   import { Button, ThemeStyle } from "@cove/ui";
 *   import "@cove/ui/tokens.css";
 *
 * There are no client-only hooks in here, so every export is safe to render from
 * a server component.
 */

export { cx } from "./cx";

export { Button } from "./components/Button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./components/Button";

export { Card } from "./components/Card";
export type { CardProps } from "./components/Card";

export { MediaCard } from "./components/MediaCard";
export type {
  MediaAmbient,
  MediaAspect,
  MediaBadgePosition,
  MediaCardProps,
} from "./components/MediaCard";

export { Badge } from "./components/Badge";
export type { BadgeProps, BadgeVariant } from "./components/Badge";

export { Avatar } from "./components/Avatar";
export type { AvatarProps, AvatarSize } from "./components/Avatar";

export { ThemeStyle } from "./theme-style";
export type { ThemeStyleProps } from "./theme-style";

export {
  DEFAULT_THEME,
  PRESETS,
  THEME_NAMES,
  contrastRatio,
  suggestReadableInk,
  tokensToCss,
  tokensToDeclarations,
} from "./themes";
export type {
  PresetMeta,
  ThemeCardStyle,
  ThemeDensity,
  ThemeMode,
  ThemeName,
  ThemeRadius,
  ThemeTokens,
} from "./themes";
