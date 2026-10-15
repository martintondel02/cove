# Self-hosted live-streaming stack brief — single-tenant personal site

Verified 2026-10-15 against upstream repos/docs and Docker Hub. Target: Podman/Docker Compose, one Fedora box, no CDN, modest uplink.

## 1. Recommendation

**MediaMTX v1.21.2** (MIT, released 2026-10-08) as the only media component, image `bluenviron/mediamtx:1-ffmpeg` (also `:1`), run with `--network=host`.

It alone covers the whole ask: RTMP ingest (1935), SRT (8890/udp), WHIP (`:8889/<path>/whip`) and a built-in browser publish page (`:8889/<path>/publish`), WHEP/sub-second WebRTC playback (`:8889`), true LL-HLS on by default (`hlsVariant: lowLatency`, 1 s segments, 200 ms parts, `:8888`), MPEG-TS/RTP/RTSP/MoQ-QUIC (8892/8893), per-path disk recording in fMP4 or MPEG-TS, and a playback/DVR server (`:9996`) that serves recorded timespans as MP4 without re-encoding. Add **Caddy** (TLS/WSS) and **coturn** only if WebRTC fails behind CGNAT. Keep chat in your app's own backend.

Alternatives: **Owncast v0.3.0** (MIT, `owncast/owncast:0.3.0`) is the best turnkey option (video + admin + chat + HLS) but is RTMP-ingest-only with a ~5 s latency floor. **SRS v6.0-r2** (MIT, `ossrs/srs:v6.0.193`) has WHIP/WHEP (`/rtc/v1/whip|whep`), SRT (10080/udp) and clustering, but no LL-HLS parts (docs: HLS "cannot be less than 5 s") and a much larger config surface. **nginx-rtmp-module 1.2.2** (BSD-2): no release since 2019, no SRT/WHEP/LL-HLS, 1154 open issues. **Ant Media 3.1.0**: Community Edition Apache-2.0, Enterprise paid (from $89/mo), heavy Java, no verified Docker Hub image. **OvenMediaEngine** (AGPL-3.0) is credible but its current version is unverified here.

## 2. Latency and scale reality check

| Mode | Glass-to-glass | Notes |
|---|---|---|
| WebRTC / WHEP | ~0.2–0.8 s | Estimate (MediaMTX publishes no figure); LAN can hit ~150–300 ms |
| LL-HLS (MediaMTX defaults) | ~1.5–3 s | 200 ms parts / 1 s segments |
| Tuned segment HLS (SRS) | 6–8 s | Their docs; floor ~5 s |
| Owncast (buffer level 0–4) | ~5–18 s | Published table |
| Default HLS | 10–30 s | SRS default ~30 s |

Scale on 4 vCPU / 8 GB (forwarding, no transcode): **egress and per-peer UDP state are the bottleneck, not CPU.** Viewers ≈ uplink ÷ bitrate: a 1 Gbps NIC ≈ 200–250 viewers at 4 Mbps, but expect ~100–300 concurrent WHEP peers per process before UDP send-buffer overhead bites (real 2026 wart: [issue #6100](https://github.com/bluenviron/mediamtx/issues/6100), a blocking-write convoy wedging sessions with a handful of WHEP readers). HLS/LL-HLS scale higher (stateless, cacheable) but still pay egress. On a modest uplink (25 Mbps) **all modes are unicast, so ~5–8 viewers at 4 Mbps** — the levers are lower bitrate (720p30 @2.5 Mbps ≈ 10 viewers) or read replicas + L7 sticky LB. One 720p software transcode costs ~0.5–1 core; a bad trade here. Concurrency figures are reasoned estimates, not benchmarks.

## 3. Browser-based streaming

Mature as of 2026: MediaMTX ships a WHIP publish page (getUserMedia → `:8889/<path>/publish`) plus standalone `publisher.js`; OBS has had WHIP output since 30.0.0 (current 32.2.2); FFmpeg/GStreamer/Unity do WHIP too. Caveats: publish H264 **baseline, no B-frames** + Opus; no transcoding means your encoded quality is final; screen share needs a custom `getDisplayMedia` page (the stock page is camera/mic). In-browser scene composition means canvas → `captureStream()` → WHIP: possible but CPU-hungry, with no overlays, transitions or audio mixing — OBS still wins. For multi-guest use Jitsi (Apache-2.0) or VDO.Ninja and publish the composite to MediaMTX.

## 4. Chat

Simplest architecture meeting moderation + slow mode + ephemerality: **your own single WebSocket endpoint** in the existing site backend. Ring-buffer the last ~200 messages in memory/Redis with a TTL — that *is* ephemerality; never persist message text. Persist only moderation state (mod list, bans). Slow mode = per-user token bucket; moderation = role check + ban list; identity stays consistent with the site's auth for anonymous viewers. Owncast's built-in chat has moderators/hide/ban but **no documented slow mode** — use it only if you adopt Owncast wholesale. Matrix doesn't fit: the C-S spec has no user-visible ephemeral message type (its ephemeral data units are typing/receipts) and no spec'd slow mode. IRCv3 is inherently ephemeral but needs a gateway for web viewers and services-based moderation, with no standard slow mode.

## 5. Recording → VOD handoff

Record fMP4 (`recordFormat: fmp4`) for web handoff; MPEG-TS only for truncated-file crash tolerance. Gotcha: MediaMTX loses the last fMP4 part on crash, so `recordPartDuration` (1 s) *is* your RPO. Standard flow, all `-c copy` (no re-encode): (1) fire on the `runOnRecordSegmentComplete` hook, then remux `ffmpeg -i seg.mp4 -c copy ep.mp4` (add `-bsf:a aac_adtstoasc` for MPEG-TS); (2) publish with `-movflags +faststart`, build HLS VOD with `-f hls -hls_playlist_type vod -hls_time 6`; (3) or skip it — MediaMTX's playback server (`:9996/list`, `/get?...&format=mp4`) serves DVR directly; (4) thumbnail `ffmpeg -ss 5 -i ep.mp4 -frames:v 1 -vf scale=1280:-2 thumb.jpg`, plus a live poster via a `runOnAvailable` snapshot loop; (5) chapters via `ffmetadata` `[CHAPTER]` blocks or mux to MKV.

Re-encode only for a baseline rendition or ABR ladder. Other traps: don't remux a still-open fMP4 (moov unfinalized); MPEG-TS PTS wraps ~26.5 h; Opus-in-MP4 is patchy in Safari (remux audio to AAC).

## 6. Pain points

- **NAT/firewall:** open UDP 8189 (WebRTC) and 8890 (SRT). If UDP is blocked: `webrtcLocalTCPAddress: :8189`, then STUN, then TURN. CGNAT breaks all inbound — use a VPS relay.
- **Containers:** bridge networking breaks WebRTC/RTSP UDP; set `MTX_WEBRTCADDITIONALHOSTS` to the public IP and `MTX_RTSPTRANSPORTS=tcp`, or use `--network=host`.
- **TLS/secure context:** `getUserMedia`/`getDisplayMedia` need HTTPS (except localhost); HTTP media on an HTTPS page is blocked as mixed content. Terminate TLS in Caddy, disable proxy buffering for HLS.
- **CORS:** `hlsAllowOrigins`/`playbackAllowOrigins` default `*`; restrict in production.
- **Autoplay:** unmuted autoplay is blocked — start muted, require a click for sound (MediaMTX iframe already defaults `muted=true`, `playsInline=true`).
- **SRT vs RTMP:** RTMP (TCP, head-of-line blocking, ~1–3 s, universal, unencrypted) vs SRT (UDP + ARQ + AES, tuneable sub-second, better on lossy links); SRT latency set too low causes loss. OBS supports both.

## Sources

[MediaMTX v1.21.2 release](https://github.com/bluenviron/mediamtx/releases/tag/v1.21.2) · [install/images](https://mediamtx.org/docs/kickoff/install) · [browser publish](https://mediamtx.org/docs/publish/web-browsers) · [WHIP/WHEP](https://mediamtx.org/docs/publish/webrtc-clients) · [WebRTC specifics](https://mediamtx.org/docs/features/webrtc-specific-features) · [record](https://mediamtx.org/docs/features/record) · [playback/DVR](https://mediamtx.org/docs/features/playback) · [issue #6100](https://github.com/bluenviron/mediamtx/issues/6100) · [Owncast latency](https://owncast.online/docs/latency/) · [Owncast moderation](https://owncast.online/docs/chat/moderation/) · [SRS HLS latency](https://ossrs.io/lts/en-us/docs/v6/doc/hls) · [SRS WHIP/WHEP](https://ossrs.io/lts/en-us/docs/v6/doc/webrtc) · [SRS SRT](https://ossrs.io/lts/en-us/docs/v6/doc/srt) · [OBS 30.0.0 WHIP](https://github.com/obsproject/obs-studio/releases/tag/30.0.0) · [nginx-rtmp-module](https://github.com/arut/nginx-rtmp-module) · [Ant Media CE license](https://github.com/ant-media/Ant-Media-Server/blob/master/COMMUNITY_EDITION_LICENSE) · [Ant Media pricing](https://antmedia.io/pricing/) · [OvenMediaEngine (AGPL)](https://github.com/AirenSoft/OvenMediaEngine) · [Matrix C-S spec](https://spec.matrix.org/latest/client-server-api/) · [MDN autoplay policy](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
