import Link from "next/link";
import { notFound } from "next/navigation";
import { findLatestJobForPost, getPostBySlug, getPublishedVideoBySlug } from "@cove/db";
import { Badge } from "@cove/ui";

import { VideoPlayer } from "@/components/VideoPlayer";
import { mediaUrl } from "@/lib/media";
import { loadSiteContext } from "@/lib/site";

export const dynamic = "force-dynamic";

function formatDate(value: Date | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(value);
}

export default async function WatchPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const site = await loadSiteContext();
  const video = await getPublishedVideoBySlug(slug);

  if (!video) {
    // Distinguish "still being processed" from "does not exist": a video that takes
    // two minutes to transcode should not look like a broken link.
    const pending = await getPostBySlug(slug);
    if (pending && !pending.deletedAt && pending.publishedAt === null) {
      const job = await findLatestJobForPost(pending.id);
      return (
        <main className="cove-shell">
          <section className="cove-section">
            <div className="cove-panel">
              <h3>{pending.title}</h3>
              <p>
                This video is still being processed
                {job ? ` — ${job.state}, ${job.progress}%` : ""}. The page will show the
                player as soon as it is ready.
              </p>
              {job?.error ? <ul className="cove-hints"><li>{job.error}</li></ul> : null}
              <p style={{ marginBottom: 0 }}>
                <Link className="cove-mono-link" href="/videos">
                  ← Back to videos
                </Link>
              </p>
            </div>
          </section>
        </main>
      );
    }
    notFound();
  }

  const poster = video.posterPath ? mediaUrl(video.posterPath) : null;
  const playlist = video.masterPlaylist ? mediaUrl(video.masterPlaylist) : null;

  return (
    <main className="cove-shell">
      <section className="cove-section" style={{ marginTop: "28px" }}>
        {playlist ? (
          <VideoPlayer
            src={playlist}
            poster={poster}
            slug={video.slug}
            ambient={video.dominantColor}
          />
        ) : (
          <div className="cove-panel cove-panel--problem">
            <h3>This post has no playable media yet</h3>
            <p>The processing job may have failed part-way through.</p>
          </div>
        )}
      </section>

      <section className="cove-section">
        <div className="cove-section-head">
          <h2>{video.title}</h2>
          <p>
            {formatDate(video.publishedAt)}
            {video.remuxOnly ? " · delivered as-is, no re-encode" : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", marginBottom: "14px", flexWrap: "wrap" }}>
          <Badge>{video.kind}</Badge>
          <Badge>{video.visibility ?? "public"}</Badge>
          {Array.isArray(video.renditions) && video.renditions.length > 0 ? (
            <Badge>
              {(video.renditions as { name?: string }[])
                .map((rung) => rung.name)
                .filter(Boolean)
                .join(" · ")}
            </Badge>
          ) : null}
        </div>
        {video.body ? (
          <div className="cove-panel">
            <p style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>{video.body}</p>
          </div>
        ) : null}
      </section>

      <footer className="cove-footer">
        <Link href="/videos">← All videos</Link>
        <Link href="/">{site.siteName}</Link>
        <span className="cove-mono-link">/p/{video.slug}</span>
      </footer>
    </main>
  );
}
