# Phase 1 — video core: progress

**Status: complete.** An upload goes in through the browser-facing stack and comes out
as a playable video, verified by decoding a frame from the served HLS stream.

Verified 2026-10-15 against the running stack (rootless Podman 5.8.7, Fedora 44).

## Done

### `packages/media` — the pipeline's decision-making, kept pure

| Module | Responsibility |
| --- | --- |
| `run.ts` | Spawns ffmpeg/ffprobe with **argv arrays, never a shell** — media filenames come from uploads. Supports `cwd`, which the encoder needs because HLS output patterns are relative. |
| `probe.ts` | ffprobe → `ProbeResult`. Defended against what ffprobe really emits: numbers as strings, rational frame rates, cover art posing as video, and rotation metadata. Parsing is split from spawning so it is testable. |
| `decide.ts` | remux vs transcode vs *"copy the video, fix only the audio"*. |
| `commands.ts` | One ffmpeg process, one decode, N encodes via `split`, with aligned keyframes. |
| `artifacts.ts` | Poster frame, ambient colour (scale to 1×1, read three raw bytes — no image library), scrubber sprite sheets with a WebVTT `#xywh` index. |

### `apps/worker` — the orchestration

Consumes `media.process` from pg-boss and runs: probe → decide → encode into scratch →
artefacts → atomic swap → publish in one transaction. No build step: Node strips the
TypeScript directly.

Running now:

```
cove_worker_1   Up   "worker ready — waiting for jobs on \"media.process\""
```

### Verified end to end, on real files

Two fixtures, both published correctly:

| Fixture | Decision | Result |
| --- | --- | --- |
| H.264 + AAC, 640×360 | **copy** — *"Already H.264 + AAC and within the size budget — remuxing without re-encoding."* | `master.m3u8`, `v0/{init.mp4,seg_00000.m4s}`, poster, sprite sheet + VTT |
| mpeg4 + AAC, 1280×720 | **transcode** — *"Video codec mpeg4 is not playable in all browsers"* | 2-rung ladder, `v0/` 1280×720 and `v1/` 854×480, `CODECS="avc1.64001f,mp4a.40.2"` |

Database after both runs: `media_jobs` all `ready` at 100%, `posts.published_at` set,
`videos.remux_only` correctly `t` for the copy and `f` for the transcode with 2 rungs,
and 5 `media_assets` rows per post (source, poster with extracted ambient colour, hls,
sprite sheet, sprite index).

The copy path takes seconds and loses no quality; the transcode path produced a correct
ABR ladder with libx264 in the worker image.

### The web half

- **`POST /api/uploads`** — tus 1.0.0 resumable uploads via `@tus/server`, whose
  `handleWeb(Request)` drops straight into a route handler. Auth is checked in the
  wrapper, not in the library's callbacks, because those can only reject by throwing
  (which yields a default 500 rather than an honest 401).
- **`POST /api/posts`** — creates the post, the job row, and the queue entry. The post is
  rolled back if queueing fails, since a post with no job is one that never appears.
  `published_at` stays null until media exists, so a half-processed upload is never listed.
- **`/media/*` served by Caddy** off the shared volume, with `handle` rather than
  `handle_path`: stored paths already begin with `media/`, so a stored path *is* its URL.
  Node never shovels video bytes through its event loop.
- **`/watch/[slug]`** — hls.js, native HLS on Safari, real quality selection. A post that
  exists but is still processing shows its job's progress rather than a 404.
- **`/videos`** — the masonry library grid.
- **`POST /api/views`** — watch time, keyed by a salted hash of a first-party cookie.
  No IP is stored, and there is no third-party analytics anywhere in the project.

Publishing is gated by `COVE_ADMIN_TOKEN`; **an unset token disables publishing** rather
than leaving it open. Phase 2 replaces this with passkeys.

## Verified end to end, through the running stack

`ffmpeg` fixture → tus upload → create post → worker → Caddy → decode. 13/13 checks:

| Check | Result |
| --- | --- |
| `POST /api/uploads` (tus create) | `Location: .../api/uploads/<id>` |
| `PATCH` (tus bytes) | 204 |
| `POST /api/posts` | 202, `{slug, url, job}` |
| job progression | `queued 0%` → `ready 100%`, `published_at` set |
| `GET /watch/<slug>` | 200, `<video>` + playlist + poster |
| `GET /media/.../master.m3u8` | 200, `application/vnd.apple.mpegurl` |
| `GET /media/.../v0/index.m3u8` | 200 |
| `GET /media/.../seg_00000.m4s` | 200, 165,700 bytes |
| Ranged request on a segment | **206** with `Content-Range`, `Accept-Ranges: bytes` |
| `GET /media/.../poster.webp`, `sprite.vtt` | 200, correct types |
| `GET /videos` | 200, lists the new video |
| `POST /api/views` | 204, one `view_events` row, hash only |
| Writes with no or wrong token | **401** on both endpoints |

And the proof that matters, decoding a frame from the served stream:

```
ffmpeg -i http://localhost:8080/media/<post>/master.m3u8 -frames:v 1 /tmp/frame.jpg
  → 640x360, 9,795 bytes
ffprobe the same URL
  → hls, h264 640x360, aac 1ch, duration 4.0s
```

## Findings worth keeping

Eight issues surfaced only by running the thing. The pattern is consistent enough to be
worth stating: **the decisions reviewed fine, and reality disagreed.**

1. **The queue job id and the `media_jobs` row id were conflated.** Progress updates
   matched no row, so a job could finish with the UI still showing "queued".
2. **Container uid ≠ host uid under rootless Podman.** uid 1000 in the container maps into
   a subordinate range, so a bind mount owned by the operator is not writable and jobs die
   with `EACCES: permission denied, mkdir '/data/media'`. Running as container-root maps to
   the invoking user, so published media stays owned by the operator and remains manageable
   from the host. Compose documents the rootful-Docker alternative.
3. **The repository's files were mode 600**, and build tools preserve source modes, so the
   non-root container could not read its own application: `Cannot read package config
   /app/package.json: permission denied`. Fixed the tree and `--chown`ed every `COPY`.
4. **A fixed sprite interval is a hard failure, not a cosmetic one.** At 10 s, a 3 s clip
   yields *zero* frames, and ffmpeg treats "nothing written" as an error — so every short
   upload would lose its scrubber. The interval is now derived from the duration.
5. **ffmpeg's `image2` muxer numbers from 1**, so the VTT said `sprite_000.jpg` while the
   file was `sprite_001.jpg` — wrong name *and* wrong index, i.e. a scrubber that 404s in
   the browser. An integration test now asserts the VTT names match the files on disk.
6. **`erasableSyntaxOnly` is not optional here.** Node strips types rather than compiling
   them, so a constructor parameter property fails at *runtime* with a syntax error. The
   flag turns that into a typecheck failure, which is where it belongs.
7. **`pg-boss` v12 has no default export and no `teamSize`** — it is `localConcurrency`, and
   queues must be created explicitly. The research brief was wrong about `teamSize`.
8. **`fps=1/10` looked like the cause of (4) and was not.** The filter is fine; producing
   zero frames is what failed. Worth remembering before "fixing" the wrong thing.
9. **`:Z` is the wrong SELinux relabel for a volume several containers share.** It labels
   the directory *privately for one container*, so with three mounters the last one wins and
   the others are denied. The symptom was specific and confusing: the worker could write
   `/data` while the web app and Caddy both got `EACCES`, on the same volume, as the same uid.
   **`:z` (lowercase) is the shared form.** Phase 0's note recommending `:Z` was right for a
   single container per path and wrong the moment three shared one.
10. **pnpm's strictness keeps `drizzle-orm` out of the web app**, so route handlers cannot
   import it. That is a feature: all SQL now lives in `packages/db`, which also means the
   `private`-post rules sit next to the schema instead of being repeated per call site.

## Test suite

110 tests, all passing with **0 skipped** in CI (which has libx264, so the transcode
integration test runs there; locally it is skipped because Fedora ships `ffmpeg-free`).

- `packages/shared` 13 — environment parsing, including the boolean-flag inversion bug
- `packages/media` 76 — decisions, argument construction, and integration tests that
  synthesise clips with `lavfi` and assert real ffmpeg output
- `apps/worker` 21 — progress parsing, layout, disk guard, atomic publish

```bash
pnpm test                       # everything, on the host
podman run --rm -v "$PWD/packages/media:/pkg:ro" -w /pkg node:24-alpine \
  sh -c 'apk add --no-cache ffmpeg >/dev/null && node --test'   # with libx264
```
