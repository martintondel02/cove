# Prior Art & Build-vs-Fork Brief — Self-Hosted Single-Tenant Personal Media Site
*Oct 2026. Verified from primary sources (repos, LICENSE files, docs). Search APIs were unavailable, so there is no forum/issue-tracker sentiment aggregation — see Flags.*

## 1. Survey

| Project | Strength | Stack | License | Reuse vs fork |
|---|---|---|---|---|
| **PeerTube** | Federated video, P2P, live, moderation | Node/TS, Postgres+Redis, ffmpeg, **mandatory Nginx** | **AGPL-3.0** | Real plugin/theme system (hooks, client-script scopes, CSS vars), but you inherit federation+admin you don't want. |
| **MediaCMS** | Closest thing to "personal YouTube": multi-profile transcode (h264/h265/vp9, 144p–1080p), REST API | Django+React, Celery, Postgres, Redis, Nginx, ffmpeg | **AGPL-3.0** | Best *fork* candidate if you fork anything; single-tenant friendly. |
| **Owncast** | Single-user live + built-in chat, trivial ops | Go + React, RTMP, single binary | **MIT** | Best *live* fork target — MIT keeps your frontend free. |
| **MediaMTX** | Protocol router: WebRTC/SRT/RTMP/HLS/RTSP, recording, playback, Control API, hooks, JWT auth | Go, zero-dependency binary | **MIT** | **Reuse as a service.** Your player UI on top. |
| **Jellyfin** | Library mgmt, HW-accelerated transcode | C#/.NET + `jellyfin-ffmpeg` | **GPL-2.0** | Reuse patterns only; GPL blocks code copying. |
| **Immich** | Best-in-class photos: EXIF, thumbnails, face/CLIP search, mobile upload | TS/NestJS + SvelteKit, Postgres+**VectorChord** (pgvecto.rs dropped), Redis/BullMQ, Python ML | **AGPL-3.0**, owned by **FUTO**, paid tier exists | **Reuse headless** via its REST API. Don't fork — v3.0 (Jul 2026) shipped a huge breaking-change list. |
| **PhotoPrism** | TF auto-tagging, Go speed | Go | **AGPL-3.0 + §7 Additional Terms** (trademark clause) | Shows AGPL §7 add-ons; also paid tiers. |
| **Pixelfed** / **Loops** | ActivityPub photo feed / federated reels (2025) | PHP/Laravel | **AGPL-3.0** (both) | UX reference only; federation is dead weight single-tenant. |
| **Hovod** (2025/26) | "Self-hosted Mux": upload→adaptive HLS 360p–8K, analytics, embeddable player | **One container**: API+worker+dashboard+**embedded MariaDB/Redis**, ffmpeg, all state in `/data` | **MIT** | **Most interesting entrant.** No open-core, no metering, documents running your own paid service. Caveat: **S3 storage required** — playback is served from S3, not local disk. |
| **AzuraCast** | "Radio in a box", exemplary guided first-run + now-playing UX | PHP+Vue, Docker | **AGPL-3.0** | **Onboarding UX template**, not code. |
| Others | Ghost MIT (editorial UX), Ente AGPL (E2EE photos), SRS MIT (RTMP/WebRTC/SRT), LiveKit Apache-2.0 (SFU), OvenMediaEngine AGPL, Lychee/Piwigo/Damselfly (galleries) | — | — | Secondary. |

**The gap is real:** the "personal YouTube" slot is thin — PeerTube is federated-first, MediaCMS is a CMS, the rest are Mux-clones or torrent streamers. No project spans video + live + photos.

## 2. Build vs Fork — Recommendation

**Build the frontend and product shell; reuse backends as services. Do not fork any single project — none covers all three verticals.**

Forking fails structurally: nothing spans video+live+photos, and the closest matches are **AGPL** (PeerTube, MediaCMS, Immich, Loops, Pixelfed) — fine for a personal site, a trap if you later want a proprietary or dual-licensed product.

**Reuse as services:**
- **MediaMTX (MIT)** — live ingest (RTMP/SRT) + delivery (WebRTC/HLS) + recording + hooks.
- **Immich (AGPL), headless** — EXIF, thumbnails, face/CLIP search, mobile upload via REST API.
- **ffmpeg** (or `jellyfin-ffmpeg`) — on-demand transcode → HLS.
- **imgproxy/imagor**, **blurhash/thumbhash**, libvips over ImageMagick — image derivatives and placeholders.

**Write from scratch:** the unified feed/timeline and design system (your only real differentiator), single-owner auth, upload UX, player chrome, live chat over WebSocket, first-run wizard, backup/restore orchestration, and the API gateway unifying all three services. Custom frontend is the only route to a cohesive premium feel — and it keeps your own code permissively licensed.

**Licensing consequence:** running AGPL Immich as a *separate container* behind your API keeps your code yours; AGPL obligations attach to Immich, whose source you must offer. Never copy Immich code into your frontend.

## 3. Deployment Lessons

**The benchmark — Nextcloud AIO:** a **master container** managing/updating all others, a **web UI** (8080/8443), **automatic Let's Encrypt TLS**, **no mandatory reverse proxy**, **optional BorgBackup** with create/restore/integrity-check from the UI, one-archive full-instance restore, daily auto backup+update, and **free dynamic-DNS registration** so domain-less users still succeed. That is the bar.

**Confirmed pain points:**
- **Mandatory reverse proxy.** PeerTube *"only provides official configuration files for Nginx"* and **does not support changing the webserver hostname**; needs Postgres+Redis+certbot before first run.
- **Hardware cost.** Immich needs **6 GB RAM min / 8 GB recommended, 2–4 cores**, Postgres on local SSD (never a network share), and a **x86-64-v2** CPU floor since v3.
- **Breaking upgrades.** Immich v3 removed env vars, dropped pgvecto.rs, changed error shapes, removed endpoints, required a VectorChord migration. Every major version is a project.

**Do differently:**
1. **One `compose.yaml`** — pinned tags (never `:latest`), healthchecks, amd64+arm64.
2. **Embedded DB by default, external optional** (Hovod's model: MariaDB+Redis in-container, all state in `/data`, `DATABASE_URL`/`REDIS_URL` to scale out). Offer SQLite for pure single-user.
3. **No mandatory reverse proxy** — HTTP on one port, TLS/proxy opt-in. Document MediaMTX's default ports (WebRTC UDP **8189**, RTSP 8554, RTMP 1935, HLS 8888, WebRTC 8889) and auto-generate self-signed certs.
4. **Guided first-run wizard** (AIO/AzuraCast style): owner account → storage → optional domain/TLS → hardware probe that *recommends* transcode settings instead of failing.
5. **Backups as a first-class button** — one archive, restore to a fresh host, plus CLI escape hatch.
6. **Be honest about storage** — local disk for photos/recordings; note S3-backed designs trade simplicity for bandwidth offload.

## 4. Licensing Pitfalls

- **AGPL-3.0** — network copyleft: if users interact with your *modified* version over a network you must offer Corresponding Source. It **does not** prevent commercial hosting, but hosts inherit source duties. §7 allows **additional terms** (PhotoPrism's trademark clause). You **cannot relicense** AGPL code you don't own.
- **SSPLv1** — not OSI-approved; §13 requires offering the source of the **entire service stack**, including your management tooling, to anyone you serve. Very broad; avoid.
- **BUSL-1.1** — source-available, not open source. Restricts competing hosted/embedded production use, and **auto-converts** at a Change Date (Terraform: *"four years"* → **MPL 2.0**).
- **Redis precedent** — Redis 8+ is **tri-licensed RSALv2 / SSPLv1 / AGPLv3**; ≤7.2 stays BSD-3-Clause. Expect churn in Redis/Valkey deps.
- **CLA vs DCO** — a **CLA** (copyright assignment or broad relicensing grant) is what enables later dual-licensing/relicensing; a DCO does not. Every successfully relicensed project had one — and that is what made Redis/Elastic/Grafana controversial.

**Suggested license: AGPL-3.0 plus a CLA** (or a DCO with an explicit relicensing grant). AGPL explicitly permits others to **commercially host** while network copyleft stops a cloud vendor taking your code proprietary; the CLA preserves open-core/dual-license optionality. If ecosystem embedding and maximal adoption outrank freeriding protection, use **Apache-2.0** — cf. Hovod: MIT, no open core, monetizing the identical build as hosted SaaS.

## Flags / Uncertainties
- **Ant Media Server Community Edition license unverified.** GitHub reports `NOASSERTION`; no license file at expected paths; `antmedia.io/licensing/` 404s; the site links a EULA and splits Community vs Enterprise. Treat as **source-available with commercial tiers, not clearly open source**.
- **Shimmie2** repo slug unconfirmed. **LibrePhotos** shows MIT + active pushes; maintainer health unverified.
- **No issue-tracker/forum aggregation was possible** (search API key missing), so complaint claims come from official docs/license files — stronger but narrower. Reddit-level sentiment is **unverified**.
- Immich's AGPL + FUTO paid tier means its stance could shift again; re-check before long-term dependence.
