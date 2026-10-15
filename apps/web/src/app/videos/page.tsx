import Link from "next/link";
import { listPublishedVideos } from "@cove/db";
import { Button, MediaCard } from "@cove/ui";

import { mediaUrl } from "@/lib/media";
import { loadSiteContext } from "@/lib/site";

export const dynamic = "force-dynamic";

export const metadata = { title: "Videos" };

function relative(value: Date | null): string {
  if (!value) return "";
  const seconds = Math.round((Date.now() - value.getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (seconds >= size) return formatter.format(-Math.round(seconds / size), unit);
  }
  return "just now";
}

/**
 * The library.
 *
 * A masonry grid rather than a uniform one, because the feed will soon mix 16:9
 * video with 9:16 reels and a fixed grid leaves dead space (see docs/PLAN.md §4).
 */
export default async function VideosPage() {
  const site = await loadSiteContext();
  const videos = await listPublishedVideos(48);

  return (
    <main className="cove-shell">
      <section className="cove-section" style={{ marginTop: "28px" }}>
        <div className="cove-section-head">
          <h2>Videos</h2>
          <p>
            {videos.length === 0
              ? "Nothing published yet"
              : `${videos.length} published`}
          </p>
        </div>

        {videos.length === 0 ? (
          <div className="cove-panel">
            <h3>No videos yet</h3>
            <p>
              Upload one and it will appear here once the worker has finished
              processing it.
            </p>
            <p style={{ marginBottom: 0 }}>
              <Button href="/upload" variant="primary">
                Upload a video
              </Button>
            </p>
          </div>
        ) : (
          <div className="cove-masonry">
            {videos.map((video) => (
              <MediaCard
                key={video.id}
                title={video.title}
                href={`/watch/${video.slug}`}
                aspect={video.kind === "reel" ? "9:16" : "16:9"}
                interactive
                meta={
                  <>
                    <span>{relative(video.publishedAt)}</span>
                    {video.remuxOnly ? <span className="sep">·</span> : null}
                    {video.remuxOnly ? <span>as-is</span> : null}
                  </>
                }
                media={
                  video.posterPath ? (
                    // A plain <img> rather than next/image: these are already the
                    // exact sizes we generated, served straight off the media
                    // volume by Caddy, so an optimiser in between adds a hop and
                    // nothing else.
                    <img
                      src={mediaUrl(video.posterPath)}
                      alt={video.altText ?? video.title}
                      loading="lazy"
                      decoding="async"
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : undefined
                }
                ambient={
                  video.dominantColor
                    ? { from: video.dominantColor, to: "#1c1917" }
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </section>

      <footer className="cove-footer">
        <Link href="/">← {site.siteName}</Link>
        <span>Phase 1 · video core</span>
      </footer>
    </main>
  );
}
