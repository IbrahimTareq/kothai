# Kothai — multi-arch image (build with --platform linux/arm64 for Raspberry Pi / umbrelOS)
#
# Two stages:
#   1. client  — build the TypeScript + Vite frontend into /app/dist (needs devDeps)
#   2. runtime — plain Node server (+ @qvac/sdk) that serves the built ./dist
# The build step lives entirely in the throwaway client stage, so the runtime
# image stays lean. The runtime stage runs as root to repair volume ownership,

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
# node_modules — the runtime stage's prebuild pruning walks that layout.
COPY package.json pnpm-lock.yaml .npmrc ./
# The Vite build never imports @qvac/sdk or require-asset — they are server-only
# (see server/ai/providers/local.js), and @qvac ships ~7.6 GB of native prebuilds. Drop
# them before installing so this throwaway build stage doesn't download
# gigabytes it never uses. Removing deps puts package.json out of sync with the
# lockfile, hence --no-frozen-lockfile; the committed lockfile is never written
# back because this stage is thrown away.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    node -e "const p=require('./package.json'); delete p.dependencies['@qvac/sdk']; delete p.dependencies['require-asset']; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2))" \
  && pnpm install --no-frozen-lockfile --store-dir=/pnpm/store --network-concurrency=4
COPY tsconfig.json vite.config.ts index.html ./
COPY client ./client
COPY public ./public
RUN pnpm run build         # → /app/dist (index.html + hashed assets + fonts/logos)

# ─────────────────────────── Stage 2: runtime ────────────────────────────────
# NAMED, and every build of it must pass `--target runtime`. Docker builds the
# LAST stage when no target is given, and stages 3 and 4 sit below this one — an
# untargeted `docker build .` silently produces the ONCE image, not this one.
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# Runtime libs needed by the QVAC native addons (worker runs on Bare):
#   libgomp1   — llama.cpp prebuilds (OpenMP)
#   libatomic1 — rocksdb-native
#   libssl3    — Bare runtime TLS (model downloads)
#   libvulkan1 — llama.cpp Vulkan GPU backend (loadable even if unused)
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgomp1 libatomic1 libssl3 libvulkan1 \
  && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Docker derives HOME from the USER instruction, and this image has none — so
# HOME stays /root even after the entrypoint drops to uid 1000, and QVAC's
# registry corestore (which lives under ~/.qvac, not under cacheDirectory)
# fails with EACCES on first model load. /home/node ships with the base image
# already owned by uid 1000.
ENV HOME=/home/node

WORKDIR /app

# Docker auto-populates TARGETARCH (arm64 / amd64) per build platform. QVAC's
# native prebuild dirs use Node's arch naming, where amd64 is spelled "x64".
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      arm64) echo "linux-arm64" > /tmp/keep-arch ;; \
      amd64) echo "linux-x64"   > /tmp/keep-arch ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac

# Runtime deps only (--prod) — react/vite/typescript were build-time only and
# are already baked into ./dist, so the runtime image ships just @qvac/sdk.
# package.json pins @qvac/onnx to 0.15.0 via a pnpm override: 0.15.1's Linux
# prebuild is linked against libc++ symbols the Bare host does not export, so
# the worker dies at startup with CANNOT_LOAD / "undefined symbol:
# _ZTTNSt3__1...basic_ostringstream...". Drop the override once upstream ships
# a fixed build.
COPY package.json pnpm-lock.yaml .npmrc ./
COPY docker/nmtcpp-binding-stub.js /tmp/nmtcpp-binding-stub.js
# The store cache mount is what keeps rebuilds cheap: @qvac's ~7.6 GB of
# tarballs are fetched once and reused even when the lockfile changes, which a
# plain layer cache cannot do (any lockfile edit invalidates it wholesale).
# sharing=locked serializes the two arches of a multi-platform build so they
# never write the store concurrently.
#
# --network-concurrency=4 is a memory guard, not a speed knob: pnpm scales
# parallel fetch+extract with CPU count, and @qvac's prebuild tarballs are big
# enough that a many-core builder OOMs the container mid-install ("Killed",
# then "cannot allocate memory"). Four keeps peak RSS well inside an 8 GB VM.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    KEEP="$(cat /tmp/keep-arch)" \
  && pnpm install --prod --frozen-lockfile --store-dir=/pnpm/store --network-concurrency=4 \
  # @qvac/translation-nmtcpp's arm64 prebuild is compiled with ARM SVE
  # instructions and SIGILLs on CPUs without SVE (Raspberry Pi, Apple Silicon),
  # killing the QVAC worker at startup. This app never uses translation, so
  # swap the native binding for a JS stub on every arch (see the stub file).
  && cp /tmp/nmtcpp-binding-stub.js node_modules/@qvac/translation-nmtcpp/binding.js \
  && rm -rf node_modules/@qvac/translation-nmtcpp/prebuilds \
  # Strip native prebuilds for every platform except the one this image
  # targets — they account for ~3 GB of dead weight — plus the Android/iOS
  # payloads of react-native-bare-kit (server never loads them).
  && find node_modules -type d -name prebuilds -prune | while read -r p; do \
       for d in "$p"/*/; do \
         case "$d" in */"$KEEP"/) ;; *) rm -rf "$d" ;; esac; \
       done; \
     done \
  && rm -rf node_modules/react-native-bare-kit/android node_modules/react-native-bare-kit/ios

COPY server ./server
COPY docker/entrypoint.js ./docker/entrypoint.js
# Built client (Vite already copied public/ — fonts + logos — into dist)
COPY --from=client /app/dist ./dist

# Notes/uploads + downloaded model weights live here — mount both as volumes
# so they survive container upgrades (server/index.js writes qvac.config.json
# pointing the QVAC cache at /app/models on startup).
VOLUME ["/app/data", "/app/models"]

# Non-recursive: the server drops to uid 1000 and must be able to create
# /app/qvac.config.json at boot. Recursing here would rewrite ownership across
# node_modules for no reason.
RUN chown node:node /app

ENV PORT=5173
EXPOSE 5173

# Liveness, NOT model readiness. First boot downloads ~1.3 GB, and the "no AI"
# configuration never reaches state=ready at all — gating on readiness would
# make orchestrators restart-loop the container and redownload forever.
# /api/health, not /api/status: the healthcheck carries no credentials, and
# /api/status sits behind the optional password gate (STASH_PASSWORD), so
# setting a password would otherwise restart-loop the container the same way.
# `node -e` because curl/wget are not guaranteed in the slim base.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Starts as root to repair volume ownership, then execs the server as uid 1000.
ENTRYPOINT ["node", "docker/entrypoint.js"]

# ─────────────────────── Stage 3: lite runtime (remote inference) ────────────
# Same server and client, but @qvac/sdk is deleted before install — so there
# are no native prebuilds, no GGUF weights, and no models volume. Inference
# goes to an OpenAI-compatible endpoint the operator points it at.
#
# Everything the full runtime stage does for QVAC is absent by construction:
# the apt native libs (libgomp/libatomic/libssl/libvulkan exist only for the
# native addons), the TARGETARCH prebuild pruning, the nmtcpp stub, and the
# HOME=/home/node corestore workaround. With no native deps at all this stage
# is also arch-independent — nothing here can SIGILL on a Pi.
FROM node:${NODE_VERSION}-bookworm-slim AS runtime-lite

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store,sharing=locked \
    node -e "const p=require('./package.json'); delete p.dependencies['@qvac/sdk']; delete p.dependencies['require-asset']; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2))" \
  && pnpm install --prod --no-frozen-lockfile --store-dir=/pnpm/store

COPY server ./server
COPY docker/entrypoint.js ./docker/entrypoint.js
COPY --from=client /app/dist ./dist

# Notes and uploads only — there are no model weights to persist.
VOLUME ["/app/data"]

RUN chown node:node /app

ENV PORT=5173
# The lite image cannot run local inference at all: @qvac/sdk is not
# installed. Defaulting the provider here means a bare `docker run` gives the
# clear "set STASH_AI_BASE_URL" state rather than a module-not-found crash.
ENV STASH_AI_PROVIDER=remote
EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "docker/entrypoint.js"]

# ─────────────────── Stage 4: ONCE runtime (basecamp/once) ───────────────────
# The full runtime with the three defaults ONCE requires baked in, because ONCE
# installs an image by name and offers no way to set arbitrary env vars:
#   - HTTP on port 80
#   - a /up healthcheck endpoint (server/router.js, in front of the password gate)
#   - persistent data under /storage
#
# Everything else — the models, the entrypoint, the healthcheck — is inherited
# unchanged from `runtime`, so this stage is exactly that image with a different
# set of defaults, not a second build of the app.
FROM runtime AS runtime-once

# STASH_HOME is the single-root switch that already existed for hosts allowing
# only one volume (Railway); ONCE's /storage contract is the same shape. Notes,
# uploads, model weights and qvac.config.json all land underneath it.
ENV STASH_HOME=/storage
ENV PORT=80

# uid 1000 binding a privileged port works because Docker sets
# net.ipv4.ip_unprivileged_port_start=0 inside containers, so the entrypoint's
# drop from root does not have to be given up for this.
EXPOSE 80

# ONCE runs /hooks/pre-backup before archiving /storage. Root-owned and 0755:
# ONCE executes it, the app (uid 1000) never needs to write it.
COPY --chmod=0755 docker/hooks/ /hooks/

# NOTE: `runtime` declares VOLUME /app/data and /app/models, and a VOLUME cannot
# be removed by a derived stage. Under ONCE both go unused — real data lives in
# /storage — so Docker creates two empty anonymous volumes per container. They
# are inert, just untidy.
