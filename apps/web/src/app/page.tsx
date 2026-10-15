import Link from "next/link";
import { Badge, MediaCard } from "@cove/ui";

import { loadSiteContext, type SiteContext } from "@/lib/site";

// Settings and the actor are read per request, and the page must render a
// diagnostic rather than a stale cache when the database is down.
export const dynamic = "force-dynamic";

/**
 * Phase 0 has no media pipeline yet, so the feed is populated with shape
 * placeholders. They are not filler: they exercise the mixed-media masonry
 * (16:9 video beside 4:5 photos beside 9:16 reels), the ambient-colour backdrop,
 * and the per-kind badge/progress affordances — the three things the plan says
 * make video, live and photos feel like one product rather than three.
 */
const PLACEHOLDER_CARDS = [
  {
    kind: "video",
    title: "Long-form video lands in Phase 1",
    meta: "Upload, remux or transcode, then HLS playback",
    aspect: "16:9" as const,
    badge: "18:24",
    progress: 34,
    ambient: { from: "#4a6b5a", to: "#8a6a3a" },
  },
  {
    kind: "photo",
    title: "Photos, with EXIF handled properly",
    meta: "Orientation applied before metadata is stripped",
    aspect: "4:5" as const,
    ambient: { from: "#7d5a48", to: "#3f4a63" },
  },
  {
    kind: "reel",
    title: "Vertical reels, snap-scrolled",
    meta: "9:16 ladder, 2-second segments",
    aspect: "9:16" as const,
    badge: "0:41",
    ambient: { from: "#5c4a7a", to: "#7a3f52" },
  },
  {
    kind: "live",
    title: "Livestreaming is an opt-in profile",
    meta: "MediaMTX, WHEP with an LL-HLS fallback",
    aspect: "16:9" as const,
    badge: <Badge variant="live">Live</Badge>,
    ambient: { from: "#5e3a3a", to: "#2f4a6b" },
  },
];

export default async function HomePage() {
  const site = await loadSiteContext();

  return (
    <>
      <header className="cove-header">
        <div className="cove-header-inner">
          <div className="cove-wordmark">
            <span className="cove-mark" aria-hidden="true">
              C
            </span>
            {site.siteName}
          </div>
          <nav className="cove-nav" aria-label="Primary">
            <a href="/" aria-current="page">
              Home
            </a>
            <a href="/videos">Videos</a>
            <a href="/upload">Upload</a>
            <a href="#identity">Identity</a>
          </nav>
          <div className="cove-header-spacer" />
          {site.handle ? (
            <span className="cove-handle">@{site.handle}</span>
          ) : null}
        </div>
      </header>

      <main className="cove-shell">
        {site.problem ? <ProblemPanel site={site} /> : null}
        {!site.problem && site.identityDrift ? <DriftPanel message={site.identityDrift} /> : null}

        <section className="cove-hero">
          <Badge>Phase 0 · foundation</Badge>
          <h1>{site.siteName}</h1>
          <p>{site.siteTagline}</p>
        </section>

        <section className="cove-section" id="feed">
          <div className="cove-section-head">
            <h2>Recent</h2>
            <p>Shapes only — the media pipeline arrives in Phase 1</p>
          </div>

          <div className="cove-masonry">
            {PLACEHOLDER_CARDS.map((card) => (
              <MediaCard
                key={card.kind}
                title={card.title}
                meta={card.meta}
                aspect={card.aspect}
                badge={card.badge}
                progress={card.progress}
                ambient={card.ambient}
                interactive
              />
            ))}
          </div>
        </section>

        {site.actor ? <IdentityPanel site={site} /> : null}

        <section className="cove-section" id="tokens">
          <div className="cove-section-head">
            <h2>Theme</h2>
            <p>
              Preset <code>{site.preset}</code>
              {Object.keys(site.tokens).length > 0
                ? ` with ${Object.keys(site.tokens).length} stored override(s)`
                : " with no overrides"}
            </p>
          </div>
          <div className="cove-swatches">
            <Swatch
              label="Surfaces"
              values={["var(--canvas)", "var(--surface)", "var(--surface-2)", "var(--overlay)"]}
              caption="four warm layers, no hard borders"
            />
            <Swatch
              label="Text"
              values={["var(--text)", "var(--text-muted)", "var(--text-faint)"]}
              caption="never pure black or pure white"
            />
            <Swatch
              label="Accent"
              values={["var(--accent)", "var(--accent-soft)", "var(--accent-ink)"]}
              caption="one hue, contrast-corrected ink"
            />
            <Swatch
              label="Radius"
              values={["var(--r-sm)", "var(--r-md)", "var(--r-lg)"]}
              caption="soft, low-opacity depth"
            />
          </div>

          {/* Tailwind probe: if this text is styled, the `@theme inline` mapping
              resolved and the tokens are reachable as Tailwind utilities. It is
              intentionally the only utility usage on the page so that a broken
              scan is obvious rather than subtly degrading the whole layout. */}
          <p className="text-muted mt-6 text-sm">
            Tailwind probe — this line uses <code>text-muted</code> and{" "}
            <code>bg-surface-2</code>.
          </p>
          <p className="bg-surface-2 text-text rounded-md p-3 text-sm">
            Tokens are exposed to Tailwind via <code>@theme inline</code>, so a
            runtime override from the database wins over the preset.
          </p>
        </section>

        <WhatIsMissing />
      </main>
    </>
  );
}

function ProblemPanel({ site }: { site: SiteContext }) {
  const problem = site.problem;
  if (!problem) return null;

  return (
    <section className="cove-section">
      <div className="cove-panel cove-panel--problem">
        <h3>{problem.title}</h3>
        <p style={{ whiteSpace: "pre-wrap" }}>{problem.detail}</p>
        <ul className="cove-hints">
          {problem.hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function DriftPanel({ message }: { message: string }) {
  return (
    <section className="cove-section">
      <div className="cove-panel cove-panel--problem">
        <h3>Your federated identity changed</h3>
        <p style={{ whiteSpace: "pre-wrap" }}>{message}</p>
      </div>
    </section>
  );
}

function IdentityPanel({ site }: { site: SiteContext }) {
  const actor = site.actor;
  if (!actor || !site.siteUrl) return null;

  const webfinger = `${site.siteUrl}/.well-known/webfinger?resource=acct:${actor.handle}@${site.siteUrl.replace(/^https?:\/\//, "")}`;

  return (
    <section className="cove-section" id="identity">
      <div className="cove-section-head">
        <h2>Your federated identity</h2>
        <p>These URLs are permanent — remote servers cache them</p>
      </div>
      <div className="cove-panel">
        <h3>
          @{actor.handle}
          <span className="cove-handle"> · {actor.uri}</span>
        </h3>
        <p>
          The seams are live already. A fediverse server can discover and resolve
          this account today; delivery is switched on in Phase 5, and inbound
          replies stay off by default.
        </p>
        <ul className="cove-hints">
          <li>curl -H &apos;Accept: application/activity+json&apos; {actor.uri}</li>
          <li>curl {webfinger}</li>
          <li>curl -H &apos;Accept: application/activity+json&apos; {actor.outboxUri}</li>
        </ul>
        <p style={{ marginTop: "14px", marginBottom: 0 }}>
          <Link className="cove-mono-link" href={`/u/${actor.handle}`}>
            View public profile →
          </Link>
        </p>
      </div>
    </section>
  );
}

function Swatch({
  label,
  values,
  caption,
}: {
  label: string;
  values: readonly string[];
  caption: string;
}) {
  return (
    <div className="cove-swatch">
      <div className="cove-swatch-label">{label}</div>
      <div className="cove-swatch-row">
        {values.map((value) => (
          <span key={value} className="cove-chip" style={{ background: value }} />
        ))}
      </div>
      <div className="cove-swatch-value">{caption}</div>
    </div>
  );
}

function WhatIsMissing() {
  return (
    <section className="cove-section">
      <div className="cove-panel">
        <h3>What this build does and does not do</h3>
        <p>
          Honest status, because a plan that quietly overstates itself is worse
          than no plan.
        </p>
        <ul className="cove-hints" style={{ gap: "8px" }}>
          <li>✓ monorepo, design tokens, four theme presets</li>
          <li>✓ theming and branding read from Postgres, injected server-side</li>
          <li>✓ federation identity: actor, WebFinger, outbox, tombstones, content negotiation</li>
          <li>✓ compose stack, setup wizard, doctor preflight</li>
          <li>✗ upload, transcoding, HLS playback — Phase 1</li>
          <li>✗ passkeys, setup wizard UI, theme editor — Phase 2</li>
          <li>✗ image pipeline, reels viewer — Phase 3</li>
          <li>✗ live streaming, chat — Phase 4</li>
          <li>✗ outbound delivery to the fediverse (Fedify) — Phase 5</li>
        </ul>
      </div>
    </section>
  );
}
