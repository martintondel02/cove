# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
#  Cove web app.
#
#  Built from the repository root so the pnpm workspace is visible:
#    podman build -f apps/web/Dockerfile -t cove-web .
#
#  Deliberately no BuildKit cache mounts and no `--platform` pinning, so the
#  same file works under docker, podman, and rootless podman on Fedora.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=24-alpine

# ── base ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS base
# Corepack reads the exact pnpm version from package.json#packageManager, so the
# image and a developer's machine cannot drift. Official Node images ship it;
# Fedora's node does not, which is why `setup.sh` uses a standalone pnpm there.
RUN corepack enable pnpm
WORKDIR /app

# ── dependencies ─────────────────────────────────────────────────────────────
FROM base AS deps
# Manifests first: this layer only invalidates when a dependency actually
# changes, not on every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Migrations are generated ahead of time and committed under /drizzle rather
# than produced here, so the image always ships a reviewed schema history.
RUN pnpm --filter @cove/web build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    COVE_MIGRATIONS_DIR=/app/drizzle \
    COVE_DATA_DIR=/data

# Non-root, with a fixed uid/gid so bind-mounted media stays writable and
# predictable regardless of the host's user numbering.
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs cove

# `output: "standalone"` preserves the monorepo layout, so the entrypoint is
# apps/web/server.js and the traced node_modules come along inside it.
COPY --from=builder --chown=cove:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=cove:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=cove:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=cove:nodejs /app/drizzle ./drizzle

# Media root. In production this is a bind mount onto ./data.
RUN mkdir -p /data && chown cove:nodejs /data

USER cove
EXPOSE 3000

# Reports 503 while a dependency is down (see /healthz), so an orchestrator
# restarts a genuinely broken container instead of serving diagnostics forever.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
