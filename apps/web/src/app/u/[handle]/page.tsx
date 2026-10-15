import Link from "next/link";
import { notFound } from "next/navigation";
import { getActorByHandle } from "@cove/db";
import { Avatar, Badge, Card } from "@cove/ui";

import { loadSiteContext } from "@/lib/site";

// The human half of federation seam #2: `/@handle` with an HTML Accept header
// lands here (see src/proxy.ts), while a fediverse server gets the AS2 actor
// document from the same canonical URL.
export const dynamic = "force-dynamic";

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const site = await loadSiteContext();

  if (!site.configured || handle !== site.handle) notFound();

  let displayName = site.siteName;
  let bio: string | null = null;
  let actorUri = "";

  try {
    const actor = await getActorByHandle(handle);
    if (actor) {
      displayName = actor.displayName;
      bio = actor.bio;
      actorUri = actor.uri;
    }
  } catch {
    // Fall through to the configured values — the profile should still render
    // while the database is down.
  }

  return (
    <>
      <header className="cove-header">
        <div className="cove-header-inner">
          <Link className="cove-wordmark" href="/" style={{ textDecoration: "none", color: "inherit" }}>
            <span className="cove-mark" aria-hidden="true">
              C
            </span>
            {site.siteName}
          </Link>
          <div className="cove-header-spacer" />
          <span className="cove-handle">@{handle}</span>
        </div>
      </header>

      <main className="cove-shell">
        <section className="cove-section">
          <Card padded>
            <div style={{ display: "flex", gap: "18px", alignItems: "center", flexWrap: "wrap" }}>
              <Avatar size="lg" alt={displayName} />
              <div>
                <h1
                  style={{
                    fontFamily: "var(--font-display)",
                    fontSize: "28px",
                    margin: "0 0 4px",
                    letterSpacing: "-0.02em",
                  }}
                >
                  {displayName}
                </h1>
                <p style={{ margin: "0 0 8px", color: "var(--text-muted)" }}>
                  @{handle}
                  {site.siteUrl ? ` · ${site.siteUrl.replace(/^https?:\/\//, "")}` : ""}
                </p>
                <Badge>{site.visibility}</Badge>
              </div>
            </div>
            {bio ? <p style={{ marginTop: "18px", color: "var(--text-muted)" }}>{bio}</p> : null}
          </Card>
        </section>

        <section className="cove-section">
          <div className="cove-section-head">
            <h2>Nothing published yet</h2>
            <p>The feed fills in from Phase 1 onward</p>
          </div>
          <div className="cove-panel">
            <p style={{ marginBottom: 0 }}>
              This profile is already discoverable on the fediverse — the same URL
              serves this page to a browser and an ActivityStreams{" "}
              <code>Person</code> to a server that asks for it.
              {actorUri ? (
                <>
                  {" "}
                  Canonical identity: <code className="cove-mono-link">{actorUri}</code>
                </>
              ) : null}
            </p>
          </div>
        </section>

        <footer className="cove-footer">
          <Link href="/">← {site.siteName}</Link>
          <span>
            Phase 0 · <a href="https://github.com/martintondel02/cove">source</a>
          </span>
        </footer>
      </main>
    </>
  );
}
