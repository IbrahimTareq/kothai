# Kothai — multi-arch image (build with --platform linux/arm64 for a Raspberry Pi)
#
# Two stages:
#   1. client  — build the TypeScript + Vite frontend into /app/dist (needs devDeps)
#   2. runtime — plain Node server that serves the built ./dist
# The build step lives entirely in the throwaway client stage, so the runtime
# image stays lean. The runtime stage starts as root to repair volume ownership,
# then drops to uid 1000 (see docker/entrypoint.ts). Inference is never in the
# image: every AI role goes to an OpenAI-compatible endpoint (Ollama included).

# The Node major every stage builds on. A global ARG (declared before the first
# FROM) is in scope for all of them. The default is kept in step with .nvmrc and
# CI asserts they agree, because a version split between local, CI and the image
# is exactly what hid a broken test suite for over a week. CI passes the value
# read from .nvmrc explicitly; `docker build .` on its own uses this default.
ARG NODE_VERSION=22

# ─────────────────────────── Stage 1: build the client ───────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS client
# Corepack installs the exact pnpm pinned by package.json's "packageManager",
# so image and CI resolve dependencies identically. The prompt is disabled
# because there is no TTY to answer it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
# .npmrc carries node-linker=hoisted, which gives pnpm an npm-style flat
# node_modules.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/api/package.json ./packages/api/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY tsconfig.json vite.config.ts index.html ./
COPY client ./client
# @kothai/api is a workspace link whose source Vite bundles; the runtime stage
# needs only its package.json, since the server imports it as types alone.
COPY packages/api/src ./packages/api/src
COPY public ./public
# build:client is the bundler alone; `pnpm run build` is the full gate (biome,
# token lint, both typechecks) and must never run here. It has broken the image
# twice: 8ca5afb had to ship scripts/ in for lint-tokens.mjs, and 765cbf4 added
# `biome check .` — which then failed on 295 files because biome.json is not in
# this stage, and would have failed again on tsconfig.server.json/server/.
# CI (ci.yml) and `pnpm test` own the gate; the image only needs a bundle.
RUN pnpm run build:client  # → /app/dist (index.html + hashed assets + fonts/logos)

# ─────────────────────────── Stage 2: runtime ────────────────────────────────
# Kept named so CI and Railway can say `--target runtime` explicitly, and so a
# stage added below it later cannot silently become the default build.
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Runtime deps only (--prod) — react/vite/typescript were build-time only and
# are already baked into ./dist. No native deps, so this stage is also
# arch-independent: nothing here can SIGILL on a Pi.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/api/package.json ./packages/api/package.json
# The store cache mount keeps rebuilds cheap: a lockfile edit invalidates the
# plain layer cache wholesale, but the downloaded tarballs survive here.
# sharing=locked serializes the two arches of a multi-platform build so they
# never write the store concurrently.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --prod --frozen-lockfile --store-dir=/pnpm/store

COPY server ./server
COPY docker/entrypoint.ts ./docker/entrypoint.ts
# Built client (Vite already copied public/ — fonts + logos — into dist)
COPY --from=client /app/dist ./dist

# Notes and uploads — mount as a volume so they survive container upgrades.
VOLUME ["/app/data"]

RUN chown node:node /app

ENV PORT=5173
EXPOSE 5173

# Liveness only. /api/health, not /api/status: the healthcheck carries no
# credentials, and /api/status sits behind the optional password gate
# (KOTHAI_PASSWORD), so setting a password would otherwise restart-loop the
# container. The "no AI configured" install is healthy too.
# `node -e` because curl/wget are not guaranteed in the slim base.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Starts as root to repair volume ownership, then execs the server as uid 1000.
ENTRYPOINT ["node", "docker/entrypoint.ts"]
