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

## Known gaps, deliberately

- `compose.yaml` has not been run as a stack, because this machine has no
  compose provider (`doctor` detects it and `setup.sh` prints the fix). The
  services were each verified individually: Postgres, migrations, and the
  production server were all exercised together; only Caddy is unexercised.
- No keypair, so the actor document has no `publicKey`. Remote servers will
  fetch the actor but reject *deliveries* until Phase 5 adds HTTP signatures.
  This is the one real gap in the federation identity.
- Caddy is unrun, so automatic TLS is unverified.
- `apps/worker` and `packages/media` are empty placeholders; they arrive with
  Phase 1.
