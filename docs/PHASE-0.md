# Phase 0 — as built and verified

This is the evidence log for Phase 0, including the places where reality
disagreed with [PLAN.md](PLAN.md). Kept because "we planned X, we shipped Y, and
here is why" is the most useful document a project can have six months later.

**Status: Phase 0 complete.** Verified 2026-10-15 on Fedora 44, Podman 5.8.7
rootless, Node 24.18, pnpm 12.3.4, TypeScript 7.0.2.

## What exists

| Area | Delivered |
| --- | --- |
| Monorepo | pnpm workspaces: `apps/web`, `packages/{db,shared,ui}`, root tooling, CI |
| Design system | Tokens, 4 presets, 5 primitives, contrast maths, server-side theme injection |
| Database | Drizzle schema (17 tables), generated migration, settings + actor bootstrap |
| Theming | Settings and branding read from Postgres, injected into the first HTML response |
| Federation | Actor, WebFinger, outbox, followers, inbox, post objects, tombstones, content negotiation |
| Self-hosting | `compose.yaml`, `compose.live.yaml`, `setup.sh`, `scripts/doctor.sh`, Caddyfile |
| Docs | `PLAN.md`, 4 research briefs, design mockup + renders, this file |

## Verified end to end

Run against a real `postgres:18-alpine` container and the production standalone
build (`node apps/web/server.js`), with **no `.env`** in the repository.

**Boot:** migrations applied (`0000_lonely_leo.sql`, 17 tables), settings seeded,
actor created — `[cove] actor ready: http://localhost:3000/@me`.

**Content negotiation (federation seam #2) — the same URL, two representations:**

```
GET /@me   Accept: text/html                 → 200, HTML profile page
GET /@me   Accept: application/activity+json  → 200, AS2 Person
             content-type: application/activity+json; profile="https://www.w3.org/ns/activitystreams"
             id:      http://localhost:3000/@me
             inbox:   http://localhost:3000/@me/inbox
             outbox:  http://localhost:3000/@me/outbox
             followers: http://localhost:3000/@me/followers
```

**WebFinger (seam #3):**

```
?resource=acct:me@localhost:3000   → 200, subject acct:me@localhost:3000, self → /@me
?resource=acct:someone@localhost:3000 → 404
?resource=acct:me@evil.example        → 404   (refuses to speak for other domains)
```

**Visibility → AS2 audience (seam #5), tested with real rows:**

| Post | Result |
| --- | --- |
| public video | `Video`, `attributedTo` = actor URI, `to: [Public]`, `cc: [followers]` |
| unlisted reel | `Note`, `to: [followers]`, `cc: [Public]` — the correct Mastodon semantics |
| private photo | **404** — not federated, and not enumerable |
| deleted video | **410 Gone** + `Tombstone` (seam #4) |
| outbox | `totalItems: 2` — excludes both the private and the tombstoned post |

**Inbox is closed (broadcast-first):**

```
POST /@me/inbox → 403
  "This instance does not accept inbound federation activities."
  "Outbound federation only (broadcast-first). Set COVE_FEDERATION_ENABLED=true to opt in."
```

**Theming from the database, with no rebuild and no restart:**

```
before:  data-theme="cove",  no injected override
UPDATE site_settings SET theme.preset='paper', theme.tokens={"accent":"#12b886",...}
after:   data-theme="paper", tagline changed, and in the first HTML response:
         html[data-theme="paper"]{--accent:#12b886;--accent-ink:#04231a;--grain:0.05}
```

The emitted Tailwind utility is `.text-muted{color:var(--text-muted)}` — a `var()`
reference, not a baked value. That is what makes the override win, and it only
works because the design system uses `@theme inline` rather than `@theme`.

**Builds and checks:** `pnpm install`, `pnpm typecheck` (4 packages) and
`pnpm build` all pass with no environment configured — the exact CI condition.
Typecheck was proven to *fail* on a deliberately broken type, so a green run
means something.

**CI is green** on `main` (run [38807840634](https://github.com/martintondel02/cove/actions)),
all four jobs passing: *Typecheck & build*, *Shell scripts* (bash -n + shellcheck),
*Compose config* (`docker compose config` for both the default stack and the live
overlay), and *Doctor runs clean* (which runs `setup.sh --yes` and then
`doctor.sh` on a machine with nothing configured).

**`setup.sh` / `doctor.sh`,** end to end on this machine:

```
✓ podman 5.8.7        ✗ compose provider missing (correctly detected)
✗ .env missing → setup writes one: 64-char secrets, mode 600, DATABASE_URL rewritten
✓ 560 GB free         ! host ffmpeg has no libx264 (warned, and explained why it does not matter)
✓ SELinux Enforcing   ✓ 16 cores / 30 GB → suggested preset 'quality'
```

## Where reality disagreed with the plan

1. **Postgres 19 does not exist.** The VOD research brief said 19; Docker Hub's
   newest majors are 18, 17, 16, 15, 14. Pinned **18**. Corrected in the brief.
2. **Next 16.4.2 was ~20 minutes old** when the work started, and the configured
   `minimumReleaseAge: 1440` guard refused it. Pinned **16.4.1** (27h old)
   instead of weakening the guard. A foundation should not sit on a release
   nobody has run.
3. **Next 16 renamed `middleware` to `proxy`,** and it runs on the Node runtime.
   Implemented as `src/proxy.ts`.
4. **`/@handle` cannot be a Next route folder.** Directories prefixed with `@`
   are reserved for named slots, so `app/@[handle]` would be a parallel route,
   not a URL segment. The public URLs are therefore reserved in `proxy.ts` and
   rewritten internally, choosing by `Accept` — which keeps the permanent
   external contract clean *and* the implementation idiomatic.
5. **pnpm 12 replaced `onlyBuiltDependencies` with `allowBuilds`,** and
   `strictDepBuilds` defaults to true, so an unapproved build script fails the
   install rather than being skipped. Also: pnpm 12 settings live in
   `pnpm-workspace.yaml`, not `.npmrc`.
6. **TypeScript 7 defaults `types` to `[]`,** so `process` and `Buffer` vanish
   unless `"types": ["node"]` is set explicitly.
7. **Turbopack does not resolve `./thing.js` → `thing.ts`.** Internal relative
   imports in the workspace packages are extensionless. It also traces dynamic
   `path.resolve()` calls into the standalone bundle, which pulled the whole
   source tree (globals.css included) into the production image until the
   `turbopackIgnore` hint was added.
8. **Inbox routing was wrong on the first pass.** It was gated on `Accept`, so a
   server-to-server POST without an AS2 `Accept` header landed on the HTML
   profile page and returned 200 instead of 403. Non-`GET` requests now always
   route to the AS2 handler. This was caught by testing, not by review.
9. **A cascade bug in the design system** would have rendered every non-default
   preset as the default, because `:root` and `[data-theme]` tie on specificity
   and `@import` hoisted the presets above `:root`. Fixed with an explicit ladder:
   `:where(:root)` < `[data-theme]` < `html[data-theme]`.
10. **Postgres 18 changed its data directory layout.** Mounting a volume at
    `/var/lib/postgresql/data` — correct for every earlier major — makes the
    entrypoint refuse to start: *"there appears to be PostgreSQL data in
    /var/lib/postgresql/data (unused mount/volume)"*. Mount at
    `/var/lib/postgresql` instead. The container then sat in
    "Initialized (starting)" for twelve minutes with web and caddy never
    starting, because they wait on `service_healthy`.
11. **Rootless Podman cannot bind port 80.** `net.ipv4.ip_unprivileged_port_start`
    is 1024, so publishing 80 fails with *"rootlessport cannot expose privileged
    port 80"* — and caddy alone fails while the rest of the stack comes up fine.
    The host ports are now configurable and default to **8080/8443**, so an
    ordinary user needs no system changes; `doctor` detects the privileged-port
    case and prints the exact `sysctl` fix.
12. **`email` with no argument is a Caddy *parse error*.** Writing
    `email {$COVE_ACME_EMAIL}` with an unset variable made caddy exit 1 and
    crash-loop **619 times**, with no error in `podman logs` beyond
    "using config from file". Direct validation showed it:
    *"parsing caddyfile tokens for 'email': wrong argument count"*. The directive
    is now omitted with a comment explaining how to add a real one. CI did not
    catch this because `compose config` validates compose files, not Caddyfiles —
    so CI now runs `caddy validate` against the real image, in both localhost and
    public-domain modes.
13. **`z.coerce.boolean()` silently inverted every feature flag.** It coerces via
    `Boolean(value)`, and `Boolean("false")` is `true` — so
    `COVE_FEDERATION_ENABLED=false` **opened the inbox** and
    `COVE_LIVE_ENABLED=false` switched live streaming on. Caught only because an
    endpoint returned 501 where 403 was expected. Replaced with explicit parsing
    (only `true/1/yes/on` are true) and covered by 13 regression tests run by
    Node's built-in test runner — no framework, no dependency. Config parsing
    fails silently and in the opposite direction, so it deserves tests.
14. **`.js` is the wrong extension to standardise on.** Node's ESM resolver does
    no extension guessing, so extensionless imports fail when running a package
    directly; Turbopack in turn rejects `./thing.js` because the file on disk is
    `thing.ts`. Workspace packages therefore import with **explicit `.ts`
    extensions** — the one form both consumers accept. Needs
    `allowImportingTsExtensions`, which is safe because every package is noEmit.
15. **Podman's layer cache served a stale `COPY . .`.** After a source change,
    `podman compose up -d --build` reported success but the image still contained
    the old code, so the bug appeared unfixed. A `--no-cache` rebuild fixed it.
    Worth knowing before spending an hour re-debugging a fix that is already
    correct: when a container misbehaves after an edit, verify the artifact
    before re-reading the source.

## Verified through the running stack

With `podman-compose` installed, `setup.sh` then `podman compose up -d` brings up
`db` + `web` + `caddy`, and the following pass **through Caddy on :8080**:

| Check | Result |
| --- | --- |
| `/healthz` | 200, `config ok`, `database ok` |
| `/` | 200, `data-theme="cove"`, `cove-masonry` feed, stylesheet linked |
| CSS asset | 200, contains `var(--text-muted)` (tokens survive to the browser) |
| `/@me` + `Accept: text/html` | 200, the human profile page |
| `/@me` + `Accept: application/activity+json` | 200, AS2 `Person`, `id: http://localhost:8080/@me` |
| WebFinger `acct:me@localhost:8080` | 200, `self → http://localhost:8080/@me` |
| `/@me/outbox` | 200, `OrderedCollection` |
| `POST /@me/inbox` | **403** — broadcast-first, with the opt-in hint |
| Security headers | `X-Content-Type-Options`, `Strict-Transport-Security`, `Referrer-Policy`; `Server` suppressed |
| Proxy behaviour | `Via: 1.1 Caddy`, all three containers healthy |

The inbox gate was then exercised in all three flag combinations, which proves the
boolean parsing actually works in both directions rather than merely defaulting:

| `FEDERATION_ENABLED` | `ALLOW_REPLIES` | Response |
| --- | --- | --- |
| false | false | 403 "does not accept inbound federation activities" |
| true | false | 403 "Inbound replies are disabled" |
| true | true | 501 "enabled but not implemented yet" (honest — Fedify is Phase 5) |

## Known gaps, deliberately

- No keypair, so the actor document has no `publicKey`. Remote servers will fetch
  the actor but reject *deliveries* until Phase 5 adds HTTP signatures. This is
  the one real gap in the federation identity.
- **Automatic TLS is unverified** because it needs a real domain. The Caddyfile
  validates in `https://` mode, but no certificate has actually been issued.
- The `Dockerfile` `HEALTHCHECK` is ignored under Podman, which builds OCI images
  by default (*"HEALTHCHECK is not supported for OCI image format"*). The compose
  `healthcheck` covers it and is what actually runs; keep both, since Docker uses
  the image one.
- `apps/worker` and `packages/media` are empty placeholders; they arrive with
  Phase 1.
- No tests beyond environment parsing — the federation endpoints were verified by
  hand against a live database rather than by an automated suite.
