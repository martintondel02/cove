"use client";

/**
 * The video player.
 *
 * Three things worth knowing about this file:
 *
 *  1. **Safari plays HLS natively, everything else needs hls.js.** So we check for
 *     native support first and only load the library when it is needed. Getting this
 *     wrong in either direction means either a broken player on iOS or a needless
 *     100 KB of JavaScript on every page.
 *  2. **Quality selection keeps a real handle on the hls.js instance.** An earlier
 *     version dispatched custom events that nothing listened to — it looked like a
 *     working control and did nothing at all.
 *  3. **View counting rides along on the same element.** Reported from `timeupdate`,
 *     throttled and sent with `keepalive` so closing the tab still records what was
 *     watched. Every failure is swallowed: analytics must never break playback.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@cove/ui";

export interface VideoPlayerProps {
  /** HLS master playlist URL. */
  readonly src: string;
  readonly poster?: string | null;
  /** Enables view reporting for this post. */
  readonly slug?: string;
  /** Ambient backdrop colour extracted from the video, if we have one. */
  readonly ambient?: string | null;
}

/** How often to report watch progress while playing. */
const REPORT_INTERVAL_SECONDS = 15;

interface Level {
  readonly index: number;
  readonly height: number;
}

export function VideoPlayer({ src, poster, slug, ambient }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** The live hls.js instance, or null when the browser plays HLS natively. */
  const hlsRef = useRef<{ currentLevel: number; destroy: () => void } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  /** -1 means "auto", which is what hls.js uses for adaptive selection. */
  const [selectedLevel, setSelectedLevel] = useState(-1);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setFailed(null);
    setLevels([]);
    setSelectedLevel(-1);

    // Safari (and iOS) plays HLS directly, and its native path handles AirPlay and
    // the system player better than a JavaScript one does.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      return;
    }

    let disposed = false;

    void import("hls.js")
      .then(({ default: Hls }) => {
        if (disposed) return;
        if (!Hls.isSupported()) {
          setFailed("This browser cannot play HLS video. Try Safari, Chrome, Firefox or Edge.");
          return;
        }

        const hls = new Hls({ enableWorker: true });
        hlsRef.current = hls;

        hls.on(Hls.Events.ERROR, (_event, data) => {
          // Only fatal errors are worth telling the viewer about; hls.js recovers
          // from the rest by itself.
          if (data.fatal) setFailed(`Playback failed: ${data.details || data.type}`);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setLevels(hls.levels.map((level, index) => ({ index, height: level.height })));
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
          // Only reflect automatic changes; otherwise the button the viewer pressed
          // would flick back to whatever hls.js picked next.
          setSelectedLevel((current) => (current === -1 ? -1 : data.level));
        });

        hls.loadSource(src);
        hls.attachMedia(video);
      })
      .catch(() => setFailed("Could not load the video player."));

    return () => {
      disposed = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [src]);

  const chooseLevel = useCallback((index: number) => {
    setSelectedLevel(index);
    if (hlsRef.current) hlsRef.current.currentLevel = index;
  }, []);

  // ── view reporting ─────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !slug) return;

    let lastReported = 0;
    let stopped = false;

    const report = () => {
      if (stopped) return;
      const seconds = Math.round(video.currentTime ?? 0);
      if (seconds <= lastReported) return;
      lastReported = seconds;
      void fetch("/api/views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, seconds }),
        keepalive: true,
      }).catch(() => undefined);
    };

    const onTimeUpdate = () => {
      if (Math.abs(video.currentTime - lastReported) >= REPORT_INTERVAL_SECONDS) report();
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", report);
    return () => {
      stopped = true;
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", report);
    };
  }, [slug]);

  return (
    <div style={{ display: "grid", gap: "12px" }}>
      <video
        ref={videoRef}
        poster={poster ?? undefined}
        controls
        playsInline
        preload="metadata"
        style={{
          width: "100%",
          aspectRatio: "16 / 9",
          background: `radial-gradient(120% 120% at 20% 0%, ${ambient ?? "#242020"}, #0e1116)`,
          borderRadius: "var(--r-md)",
          boxShadow: "var(--shadow-2)",
          border: "1px solid var(--hairline)",
        }}
      />

      {failed ? (
        <p style={{ color: "var(--text-muted)", fontSize: "13.5px", margin: 0 }}>{failed}</p>
      ) : null}

      {levels.length > 1 ? (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: "12px", color: "var(--text-faint)" }}>Quality</span>
          <Button
            size="sm"
            variant={selectedLevel === -1 ? "primary" : "ghost"}
            onClick={() => chooseLevel(-1)}
          >
            Auto
          </Button>
          {levels.map((level) => (
            <Button
              key={level.index}
              size="sm"
              variant={selectedLevel === level.index ? "primary" : "ghost"}
              onClick={() => chooseLevel(level.index)}
            >
              {level.height}p
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
