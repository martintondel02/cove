import { tokensToDeclarations } from "./themes";
import type { ThemeName, ThemeTokens } from "./themes";

export interface ThemeStyleProps {
  preset: ThemeName;
  tokens?: Partial<ThemeTokens>;
}

/**
 * Server-safe injector for the owner's token overrides.
 *
 * Why inline CSS instead of setting variables on the client: the overrides have
 * to be in the first HTML response, otherwise the page paints the preset and
 * then snaps to the customisation (a flash of wrong theme, and a client-side
 * theme-loading waterfall we do not want). This renders no hooks and no state,
 * so it is safe in a server component and in the document head.
 *
 * It targets `[data-theme="<preset>"]` rather than `:root` on purpose: the
 * preset's own values stay in the stylesheet as the fallback layer, and the
 * overrides only win where that preset is active. `preset` is a union of literal
 * names, so it cannot carry anything injectable into the selector.
 *
 * Renders nothing when there is nothing to override.
 */
export function ThemeStyle({ preset, tokens }: ThemeStyleProps) {
  const declarations = tokensToDeclarations(tokens);
  if (declarations.length === 0) return null;

  return (
    <style
      data-cove-theme={preset}
      dangerouslySetInnerHTML={{ __html: `[data-theme="${preset}"]{${declarations}}` }}
    />
  );
}
