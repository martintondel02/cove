# Research brief — self-hosted VOD & image pipeline

> Reference material for [PLAN.md](../PLAN.md) §7.1–7.2. Verified October 2026.
> Stack assumed: Podman/Docker Compose on a single Linux box.
>
> **Correction (2026-10-15):** this brief says "Postgres 19", but no `postgres:19` image
> exists yet — Hub's newest majors are 18, 17, 16, 15, 14. Cove pins **18**. Worth noting as
> a reminder to verify version claims against the registry rather than trusting a brief.

**Reference stack:** Caddy 2 ([Apache-2.0](https://github.com/caddyserver/caddy)) → Node 24 app ([@tus/server 2.4.5](https://github.com/tus/tus-node-server), MIT) → Postgres ([PostgreSQL License](https://www.postgresql.org/about/licence/)) + [pg-boss 12.38.0](https://pgboss.io) (MIT) → ffmpeg worker containers (LGPL-2.1+, **GPL if built with libx264**) → local filesystem. Player: [hls.js 1.7.3](https://github.com/video-dev/hls.js) (Apache-2.0) + native HLS on iOS. Images: [sharp 0.35.5](https://sharp.pixelplumbing.com) (Apache-2.0).

**Two rules that fall out of this: never start in-process ffmpeg; never pick MinIO.**

## 1. Upload

**Use tus 1.0.0** — still the current spec in 2026 (there is no 2.0, per [tus.io](https://tus.io/protocols/resumable-upload)). Client: [Uppy 6.0.4 + @uppy/tus](https://uppy.io/docs/tus/) (MIT) or [tus-js-client 4.3.1](https://github.com/tus/tus-js-client) (MIT). Server: [@tus/server 2.4.5](https://github.com/tus/tus-node-server) (MIT, Node ≥20.19) with `@tus/file-store`, or the [tusd](https://github.com/tus/tusd) Go v2 (MIT) sidecar if you want zero app code.

Settings: 16–64 MiB chunks, `retryDelays`, 1–3 parallel uploads, checksum + expiration extensions; resumption via `HEAD`/`Upload-Offset`.

**Direct-to-disk wins on a single node**: ffmpeg reads the staging file locally with no copy, and GC is one directory. S3-presigned multipart ([@uppy/aws-s3](https://uppy.io/docs/aws-s3/)) only pays off with multiple nodes/CDN or an existing S3 deployment (parts stay invisible until Complete; adds CORS + lifecycle work). Plain chunked HTTP means hand-rolling idempotent offsets — skip it.

## 2. Transcoding orchestration

**Job queue + worker containers, not in-process.** Request-scoped ffmpeg dies on deploy, blocks the event loop, and has no retries.

Lightest crash-safe option: **[pg-boss 12.38.0](https://pgboss.io) (MIT, Node ≥22.12) on the existing Postgres** — jobs, retries/backoff, `expireIn`, singleton keys, dead-letter table. If Redis is already running, [BullMQ 6.3.15](https://docs.bullmq.io) (MIT) is equivalent; prefer [Valkey](https://valkey.io) (BSD-3) over Redis 8, which is tri-licensed AGPLv3/RSALv2/SSPLv1. Temporal is overkill. A hand-rolled `FOR UPDATE SKIP LOCKED` table works but you rebuild visibility and retry logic.

Crash-safe pattern: **claim → encode into `work/<id>/tmp` → atomic `rename` to the final dir → flip the DB row to `ready`**; on boot, requeue `running` jobs past their heartbeat. Idempotent output paths make retries safe. Concurrency 1 per GPU/host (`teamSize`).

## 3. Ladder and HLS muxing

**Three renditions** (a fourth only if metered mobile matters): 1080p ≈5000k, 720p ≈2800k, 480p ≈1200k, AAC-LC 128k stereo. Apple's own H.264 table (1080p 6000k, 720p 3000k, 540p 2000k) is a sane upper bound; [YouTube's guidance](https://support.google.com/youtube/answer/2853702) is comparable.

Use **fMP4/CMAF**:

```
-hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4
-hls_flags independent_segments+temp_file -hls_playlist_type vod
-master_pl_name master.m3u8 -hls_time 4
-var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2"
```

([ffmpeg HLS muxer docs](https://ffmpeg.org/ffmpeg-formats.html#hls-2))

Keyframe alignment — Apple requires an IDR at every segment start, and IDRs roughly every 2 s:

```
-g 48 -keyint_min 48 -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*2)"
```

Segments are nominally 6 s; 4 s is a fine tradeoff, 2 s for vertical.

**One ffmpeg process with `-filter_complex split` producing all renditions = one decode, N encodes — the single biggest cost saving available.**

Capped-CRF single-pass (`-crf 20 -maxrate X -bufsize 2X`) beats two-pass ABR at this scale. Per-title / shot-based encoding (Netflix convex-hull) is not worth the probe-plus-multi-encode cost for a personal library. Shaka Packager (Apache-2.0) only if DASH from the same segment set is wanted.

## 4. Hardware acceleration

**NVENC is the best Linux/container story** (NVIDIA Container Toolkit + Podman CDI). Per [NVIDIA's matrix](https://developer.nvidia.com/video-encode-decode-support-matrix), current RTX 50-series allow **12 concurrent NVENC sessions** (older cards/drivers 3–5) — far beyond need.

`-c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 23 -maxrate … -bufsize …`

**Intel QSV** (`h264_qsv -preset veryfast -global_quality 23`, pass through `/dev/dri`) is excellent value. **VAAPI** (`h264_vaapi`, `/dev/dri/renderD128`) has no CRF — CQP/VBR only, plus `-compression_level 1..7` (higher = faster/worse) — so it trails x264 in quality per bit; use it only for low tiers ([VAAPI guide](https://trac.ffmpeg.org/wiki/Hardware/VAAPI)).

**CPU fallback:** libx264 `-preset veryfast -crf 20 -threads 0` for 1080p; `faster`/`fast` when time allows ([x264 guide](https://trac.ffmpeg.org/wiki/Encode/H.264)).

Hardware encoders need ~10–20% higher bitrate for equal quality — keep the ladder, raise the bitrates. *Uncertain: quality varies by GPU generation; benchmark on real content.*

## 5. Storage and serving

**Local filesystem is the right answer on a single node** — no S3 overhead, direct range serving, `restic`/`zfs send` backups. Add object storage only for S3 semantics or multi-node.

**MinIO is dead for new deployments:** the [community repo](https://github.com/minio/minio) is **archived**, last push 2026-04-24, last release Oct 2025; [SeaweedFS's comparison](https://github.com/seaweedfs/seaweedfs) states MinIO ceased development in April 2026. Replacements:

- **[Garage](https://garagehq.deuxfleurs.fr) v2.4.1** (AGPL-3.0, Rust, single binary, `--single-node`, presigned URLs + static web) — best small-footprint pick.
- [SeaweedFS](https://github.com/seaweedfs/seaweedfs) (Apache-2.0, `weed mini`) — mature, more parts.
- [RustFS](https://github.com/rustfs/rustfs) (Apache-2.0, MinIO-compatible, active but young).

**Serving:** static HLS behind Caddy/nginx with range requests; `immutable` cache on `.m4s`/`init.mp4`, `no-cache` on `.m3u8`. Gate with HMAC-signed short-lived URLs (nginx `X-Accel-Redirect`, Caddy `forward_auth`) if links are shareable. For a single-tenant personal site, obscure paths + page auth is enough; signed URLs matter only if the media host is exposed directly.

## 6. Thumbnails and previews

**Poster:** `ffmpeg -ss 10% -i in.mp4 -frames:v 1 -vf scale=1280:-2 -c:v libwebp -quality 80 poster.webp`

**Hover preview:** `-ss 5 -t 6 -i in.mp4 -vf fps=12,scale=480:-2 -c:v libwebp -loop 0 -q:v 60` (keep < 1 MB)

**Sprite sheet for the scrubber:** `-vf "fps=1/10,scale=160:-2,tile=10x10" -q:v 3 sheet_%03d.jpg` ([tile filter](https://ffmpeg.org/ffmpeg-filters.html#tile)) plus a WebVTT with `#xywh=` cues (Roku/Netflix trickplay style). For Apple players, also emit dense I-frame playlists (`EXT-X-I-FRAMES-ONLY`, `EXT-X-I-FRAME-STREAM-INF`, ideally 1 fps).

No dominant maintained Node library exists for this. [Jellyfin](https://github.com/jellyfin/jellyfin) (GPL-2.0) is the best reference — ffmpeg frame extraction, tile composition, VTT (its [trickplay config](https://jellyfin.org/docs/general/administration/configuration/#trickplay)); use `sharp` for tiling.

## 7. Vertical shorts

Same pipeline, swapped ladder: 1080×1920 ≈4.5M, 720×1280 ≈2.5M, 540×960 ≈1.1M (drop 1080p for phone-only). Do **not** pad/letterbox — store per-video aspect and scale by width. `-hls_time 2` and 1 s keyframes for instant start and switching. Clips under 3 min encode in seconds.

Feed: `IntersectionObserver`, muted/`playsinline`/autoplay, poster from the first frame, preload only the next 1–2 items, hls.js `startLevel: -1` (or pin 720p for instant start). Clips under 60 s can be progressive MP4 for simplicity.

## 8. Images

**[sharp/libvips](https://sharp.pixelplumbing.com)** (Apache-2.0; libvips LGPL-2.1) over ImageMagick — 3–5× faster, far less memory under concurrency. ImageMagick still wins for exotic formats and bulk CLI work.

sharp's prebuilt binaries cover JPEG/PNG/WebP/AVIF/TIFF/GIF/SVG but **not HEIC** (libheif patents). Decode HEIC at ingest with a custom libvips+libheif build, or `heif-convert`. Then emit AVIF (best size, slow encode) + WebP (safe default) + JPEG.

EXIF: call `.rotate()` (apply orientation) then rely on default metadata stripping / `.withMetadata({exif:{}})` — **never strip orientation before applying it**.

**Pre-generate 3 widths + blurhash at upload with sharp** — cheapest and most cache-friendly. Use [imgproxy](https://imgproxy.net) (Apache-2.0 core, Pro is commercial) only if signed on-the-fly transforms are needed; [Thumbor](https://github.com/thumbor/thumbor) (MIT, active) is the older alternative. Do not run both.

## Flags / uncertainties

- NVENC and QSV quality is generation-dependent — benchmark.
- RustFS is young; back up regardless.
- Apple's ladder is guidance — tune per content.
- Confirm Podman CDI syntax for the target GPU driver.
- **ffmpeg licensing changes if you redistribute a GPL/libx264 build** — see the license open decision in PLAN.md §12.
