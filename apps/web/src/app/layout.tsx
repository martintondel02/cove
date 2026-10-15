import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeStyle } from "@cove/ui";

import { loadSiteContext } from "@/lib/site";

import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const site = await loadSiteContext();

  return {
    title: { default: site.siteName, template: `%s · ${site.siteName}` },
    description: site.siteTagline,
    applicationName: site.siteName,
    // An unlisted or password-gated site should never be indexed, and a public
    // one should be. Visibility already exists in the data model, so this is a
    // one-line mapping rather than a separate setting.
    robots: site.visibility === "public" ? undefined : { index: false, follow: false },
    openGraph: {
      title: site.siteName,
      description: site.siteTagline,
      type: "website",
      siteName: site.siteName,
    },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const site = await loadSiteContext();

  return (
    // `data-theme` drives the preset, and ThemeStyle layers the owner's
    // overrides on top. Both are in the first HTML response, so the page never
    // paints the preset and then snaps to the customisation.
    <html lang="en" data-theme={site.preset} suppressHydrationWarning>
      <head>
        <ThemeStyle preset={site.preset} tokens={site.tokens} />
      </head>
      <body>{children}</body>
    </html>
  );
}
