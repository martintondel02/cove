# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
#  Cove media worker.
#
#  Built from the repository root so the pnpm workspace is visible:
#    podman build -f apps/worker/Dockerfile -t cove-worker .
#
#  Two things make this image different from the web one:
#
#   1. **ffmpeg is installed here, not on the host.** Cove never uses the host's
#      ffmpeg, because many distributions ship a build without libx264 (Fedora's
#      `ffmpeg-free` is one) and "it worked on my machine" is not a valid install
#      assumption. Alpine's package has libx264, libx265, libsvtav1 and aac.
#   2. **There is no build step.** Node 24 strips TypeScript types, and the
#      workspace packages are reached through pnpm symlinks whose real paths sit
#      outside node_modules — which is exactly the case where Node will strip them.
#      So the worker runs its own source directly, and there is no dist/ to keep in
#      sync.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=24-alpine

FROM node:${NODE_VERSION} AS base
# ffmpeg and ffprobe. `--no-cache` keeps the apk index out of the layer; this is
# what makes the worker image roughly 100 MB heavier than the web image, and it is
# unavoidable.
RUN apk add --no-cache ffmpeg
RUN corepack enable pnpm
WORKDIR /app

# ── dependencies ─────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/media/package.json packages/media/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
# Production dependencies only: nothing is compiled here, so the compilers and the
# Next.js toolchain are all dead weight in this image.
RUN pnpm install --frozen-lockfile --prod

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production \
    COVE_DATA_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/media/node_modules ./packages/media/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules

# Every COPY is --chown'ed rather than trusting the source file modes. Build tools
# preserve the modes they find, and a checkout with restrictive permissions (600,
# which is what some editors and code generators produce) yields an image where the
# non-root user cannot read its own application — surfacing as the distinctly
# unhelpful "Cannot read package config /app/package.json: permission denied".
COPY --chown=node:node package.json tsconfig.base.json ./
COPY --chown=node:node apps/worker ./apps/worker
COPY --chown=node:node packages ./packages

# The `node` user in the official image is uid 1000, which is also the first regular
# user on most Linux installs, so the bind-mounted ./data is writable without any uid
# juggling. Override with `user:` in compose if your uid differs.
RUN mkdir -p /data && chown -R node:node /data
USER node

# Media never leaves the container over the network: it is read from the shared
# volume. Only the queue connection and the filesystem are needed.
CMD ["node", "apps/worker/src/index.ts"]
