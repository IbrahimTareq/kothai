# Self-hosting Kothai

One container, no database server, no account, no API key. Everything —
including the models — runs on your own hardware.

> Related: [Models & inference](models.md) for the RAM story · [Security](security.md)
> before exposing it · [all docs](../README.md#if-you-want-to)

## Before you start

| | |
|---|---|
| **RAM** | **Depends on what you enable.** AI off: ~1 GB. Search only: ~1.5 GB. The default (search always on, language model on demand): ~1.5 GB idle, more while classifying or answering. Everything always-loaded with the largest models: 9+ GB. |
| **Disk** | ~2 GB for the image, plus 1.3–3.4 GB of model weights depending on which you pick, plus your own data. |
| **CPU** | x86-64 with AVX2, or arm64. A Raspberry Pi 5 works well with the light model trio. |
| **Network** | Setup downloads the models you enable (~3.3 GB for the default trio, nothing in AI-free mode). After that it never needs the internet, except to fetch link previews. |
| **Lite** | Optional ~250 MB image with no on-device models. Inference goes to an OpenAI-compatible endpoint — see [Running lite](#running-lite-remote-inference). |

## Quick start

The wizard checks your hardware, asks three questions, and starts everything:

```bash
curl -fsSLO https://raw.githubusercontent.com/IbrahimTareq/kothai/main/scripts/init.mjs && node init.mjs
```

It picks the right image for your machine — including telling you *before* any
download if this CPU cannot run models on-device — writes `.env`, and waits
until the server actually answers before saying it is ready.

Prefer to do it by hand? The compose file below is what the wizard would write:

```bash
curl -O https://raw.githubusercontent.com/IbrahimTareq/kothai/main/docker-compose.yml
docker compose up -d
```

Open <http://localhost:5173>.

The app is usable immediately. Models download in the background — a progress
bar tracks it, and classification and Ask switch on by themselves once it reads
**Ready**. Notes saved before then keep their instant heuristic version and are
enriched later; nothing is lost.

## Other ways to run it

**Plain Docker**

```bash
docker run -d --name kothai \
  -p 5173:5173 \
  -v ./data:/app/data \
  -v ./models:/app/models \
  --restart unless-stopped \
  ghcr.io/ibrahimtareq/kothai:latest
```

**Build from source** instead of pulling the published image — uncomment
`build: .` in `docker-compose.yml`, then:

```bash
docker compose up -d --build
```

**Bare metal**, no container:

```bash
git clone https://github.com/IbrahimTareq/kothai.git
cd kothai
corepack enable          # provides the pnpm version pinned in package.json
pnpm install
pnpm start
```

## Running it with ONCE

[ONCE](https://github.com/basecamp/once) is Basecamp's self-hosting installer:
it installs Docker if the machine doesn't have it, gets a TLS certificate,
keeps the app updated and runs scheduled backups, all from one dashboard. If
you are putting Kothai on a VPS, this is the shortest path — it replaces the
reverse-proxy setup and the upgrade and backup sections below.

```bash
curl https://get.once.com | sh
```

Then point it at `ghcr.io/ibrahimtareq/kothai:once` and give it a hostname.
Budget the same RAM as any other install — ONCE makes setup easier, not the
models smaller.

The `:once` tag is the full image with the three defaults ONCE requires already
set (`PORT=80`, `STASH_HOME=/storage`, a `/up` healthcheck), because ONCE
installs an image by name and has nowhere to put environment variables. It is
the same build as `:latest` otherwise.

> [!IMPORTANT]
> ONCE gives Kothai a public hostname, which is exactly the situation the
> password gate exists for. **Set `STASH_PASSWORD`** — ONCE handles TLS, but it
> does not put an authentication layer in front of the app, and Kothai's own
> gate is off until you set one. See [security.md](security.md#the-password-gate).

Kothai ships a `pre-backup` hook, so ONCE's scheduled backups run
`POST /api/checkpoint` first and archive a database that restores cleanly. See
[Snapshot backups](#snapshot-backups-restic-borg-once) below for what that
solves. There is no `post-restore` hook on purpose: with the WAL already
truncated at backup time, putting the files back is all a restore needs, and a
hook that deleted `-wal`/`-shm` could throw away committed data.

## Running lite (remote inference)

The default image runs every model on your own hardware. The **lite** image
runs none of them — it sends classification, embedding and image captioning to
an OpenAI-compatible endpoint you point it at, and ships at ~250 MB with no
model download at all.

| | |
|---|---|
| **RAM** | ~300 MB |
| **Disk** | ~250 MB, no model weights |
| **CPU** | anything — no native inference code, so no AVX2 requirement |
| **Needs** | an OpenAI-compatible endpoint (Ollama, llama.cpp server, vLLM, OpenAI, OpenRouter) |

```bash
docker run -d --name kothai \
  -p 5173:5173 \
  -v ./data:/app/data \
  -e STASH_AI_PROVIDER=remote \
  -e STASH_AI_BASE_URL=http://ollama:11434/v1 \
  --restart unless-stopped \
  ghcr.io/ibrahimtareq/kothai:lite
```

Credentials are env-only — `STASH_AI_BASE_URL` and `STASH_AI_API_KEY` are never
written to the database and never returned by the API, so they cannot leak
through a backup or an export. Model *names* are chosen in Settings, because
they differ per endpoint.

Without an endpoint configured the lite image still runs: it serves your notes
as a plain bookmark manager with heuristic classification, the same as AI-free
mode on the full image.

## Configuration

Every setting is optional. The defaults are what the image already uses.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `5173` | HTTP port the server listens on. |
| `STASH_HOME` | *(unset)* | One root that the three paths below derive from. Use this on hosts that allow only a single volume. |
| `STASH_DATA_DIR` | `<app>/data` | Notes, chats, settings, collections, uploads. |
| `STASH_MODELS_DIR` | `<app>/models` | Downloaded model weights. |
| `STASH_CONFIG_PATH` | `<app>/qvac.config.json` | Generated QVAC config file. |
| `STASH_AI_PROVIDER` | `local` | `local` runs models on-device via QVAC; `remote` calls an OpenAI-compatible endpoint. The lite image defaults to `remote`. |
| `STASH_AI_BASE_URL` | *(unset)* | Base URL of the OpenAI-compatible endpoint, e.g. `http://ollama:11434/v1`. Remote only. |
| `STASH_AI_API_KEY` | *(unset)* | Bearer token for that endpoint. Not needed for Ollama or llama.cpp server. |
| `STASH_PASSWORD` | *(unset)* | Require this password before anything is served. Unset means no auth at all, which is the default and is fine on a LAN or a tailnet. Set it before exposing Kothai on a public hostname. |
| `STASH_ALLOW_PRIVATE_FETCH` | *(unset)* | Set to `1` to let link previews fetch private, loopback and link-local addresses. Off by default: those URLs come from pages you did not write, so an unguarded fetch turns the server into a probe for whatever network it sits on. Only turn this on to preview intranet links on a network you trust. |

Precedence: a specific variable wins over `STASH_HOME`, which wins over the
default. Relative values resolve against the app directory; absolute values are
used as-is.

**Single-volume hosts.** Some platforms (Railway, for one) allow only one volume
per service. Set `STASH_HOME=/data`, mount your single volume at `/data`, and
everything lands underneath it.

## Choosing how much RAM Kothai uses

Every AI feature maps to one of three model roles, and each role has a
residency you control in **Settings → Model Cores**:

| Residency | Meaning |
|---|---|
| **Always on** | Loaded at startup, stays in RAM. Fastest. |
| **On demand** | Loads when a feature needs it, frees its RAM after a few idle minutes. First use after idle takes a moment. |
| **Off** | Never downloaded or loaded. Features that need it are disabled. |

The three roles are Language, Embedding and Vision; [models.md](models.md#the-three-roles)
lists what each one powers and what you lose by turning it off.

The default is embedding always-on (~300 MB, so search is always instant) with
the language and vision models on demand. Saving works with **everything off**
— pick "Skip for now" during setup to run Kothai as a plain bookmark manager
on a ~1 GB box, and enable models later; Settings will offer to enrich your
already-saved notes when you do.

## What lives where

| Path | Contents | Back up? |
|---|---|---|
| `./data` | `kothai.db` (a SQLite database — notes, Spaces, chats, settings, the tag registry) and `uploads/` with your images | **Yes — this is everything you'd miss** |
| `./models` | GGUF model weights | No — they re-download |

## Backup and restore

Because the compose file uses bind mounts, your data is an ordinary directory.

```bash
# Back up
docker compose stop
tar czf kothai-backup-$(date +%F).tar.gz data/
docker compose start

# Restore
docker compose down
rm -rf data/
tar xzf kothai-backup-2026-08-17.tar.gz
docker compose up -d
```

Stopping first matters: `kothai.db` runs in WAL mode, so a live database is
really three files (`kothai.db`, `-wal`, `-shm`) that need to be copied
together in a consistent state — straightforward once the process isn't
writing to them.

Any directory-based backup tool — restic, Borg, Time Machine, a NAS snapshot —
can point at `./data` directly.

### Without stopping the container

Settings → **BACKUP** → *Download backup*, or the endpoint directly:

```bash
curl -fO -J http://localhost:5173/api/backup
```

This uses SQLite's `VACUUM INTO`, which reads one consistent snapshot — WAL
included — and writes a fresh, compacted database file. No stopping, no
three-file dance, and the result is smaller than the live database because it
is written without free pages. Use it on a PaaS where you cannot stop the
container, or whenever you just want a copy right now.

Two things to know:

- **It is the database only.** `data/uploads/` is not in it. The `meta-*`
  thumbnails there regenerate from their source URLs, but images you pasted or
  dropped into a note exist nowhere else — keep a copy of that directory too.
- It briefly needs free disk space equal to the database's size, and refuses
  while an import is running or another backup is already being prepared.

To restore, stop the container and put the downloaded file in place of
`data/kothai.db`, deleting any `kothai.db-wal` and `kothai.db-shm` beside it.

### Snapshot backups (restic, Borg, ONCE)

Tools that archive `data/` from outside the process have a problem neither of
the routes above has: they cannot ask Kothai to settle first, so a snapshot can
quietly miss recent work. Two reasons, and neither is visible to the tool:

- the background enrichment sweeps queue writes in memory and commit them in
  batches, so the newest tags and embeddings may be in no file yet;
- WAL mode means committed rows can live in `kothai.db-wal`, so `kothai.db` by
  itself is an older copy of the database.

Call this first and both go away:

```bash
curl -fX POST -H 'Content-Type: application/json' http://localhost:5173/api/checkpoint
```

It flushes the queue and truncates the WAL, so `kothai.db` **on its own** is
complete. Unlike `/api/backup` it writes no second copy, so it needs no spare
disk — worth wiring into a restic or Borg pre-hook. ONCE users get this
automatically via the shipped `pre-backup` hook.

It refuses with `409` while an import is running, which should fail your backup
rather than be ignored: settling mid-import would commit half of one.

If `STASH_PASSWORD` is set, this endpoint is behind it like everything else —
`curl` needs the session cookie, so the Settings link is the easier route.

## Upgrading

```bash
docker compose pull
docker compose up -d
```

Your data and downloaded models are untouched. If you are coming from a version
that ran as root, the container repairs file ownership automatically on first
start — no action needed.

## Putting it behind HTTPS

Kothai speaks plain HTTP, and **authentication is off unless you set
`STASH_PASSWORD`** — until you do, anyone who can reach the port can read and
write everything. Set it before putting Kothai on a public hostname, and put TLS
in front either way.

> [!TIP]
> [ONCE](#running-it-with-once) does the TLS half of this for you. You still
> have to set `STASH_PASSWORD` yourself.

Caddy is the shortest path:

```caddyfile
kothai.example.com {
    reverse_proxy localhost:5173
}
```

Nginx:

```nginx
server {
    server_name kothai.example.com;
    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        client_max_body_size 64M;   # image uploads and Instagram data exports
    }
}
```

Either way, set `STASH_PASSWORD`. Kothai's own gate covers every route and the
static fallthrough, and its session survives container restarts. For a second
layer, add Caddy's `basic_auth`, Authelia, Cloudflare Access or similar in
front. See [security.md](security.md#the-password-gate).

## Remote access without exposing anything

Tailscale is the recommended approach, and it avoids the reverse proxy
entirely. Your devices join a private mesh, so nothing is published to the
public internet and running without a password stays a reasonable choice.

The trade-off: every device you browse from needs the Tailscale client
installed and signed in. That covers your own phone and laptops. It does not
cover someone else's machine.

**Simplest — install on the host:**

```bash
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
```

Kothai is then at `http://<machine>:5173` from anywhere on your tailnet. The
`ports:` mapping still binds on every interface, so the LAN can reach it too —
bind to the tailnet address (`"100.x.y.z:5173:5173"`) if you would rather it
didn't.

**Tidier — run Tailscale as a sidecar.**
[`docker-compose.tailscale.yml`](../docker-compose.tailscale.yml) gives Kothai
its own tailnet identity and no LAN presence at all:

```bash
echo 'TS_AUTHKEY=tskey-auth-...' > .env    # admin console -> Settings -> Keys
docker compose -f docker-compose.tailscale.yml up -d
```

The app shares the sidecar's network namespace and publishes no ports of its
own. [`ts-config/serve.json`](../ts-config/serve.json) puts Tailscale Serve in
front, giving you `https://kothai.<your-tailnet>.ts.net` with a real
certificate. Enable **DNS -> HTTPS Certificates** for your tailnet first, or
the certificate request fails at startup.

> [!TIP]
> The HTTPS is not cosmetic. Kothai sets the session cookie's `Secure` flag
> only when `x-forwarded-proto` says HTTPS, which Serve provides — on a
> plain-HTTP tailnet install that flag stays off. See
> [security.md](security.md#the-password-gate).

At home Tailscale routes directly over the LAN, so the same URL is fast inside
the house and works unchanged outside it.

**From a device you cannot install a client on** — a borrowed laptop, a hotel
PC — you need a genuinely public URL, and the single shared password becomes
the only thing in front of your archive. Tailscale Funnel (add `"AllowFunnel"`
to `serve.json`) is the quickest route. Cloudflare Tunnel with Access in front
is the safer one, because unauthenticated requests never reach your machine.
Set `STASH_PASSWORD` either way, and read
[security.md](security.md#what-is-deliberately-not-protected) first.

> [!NOTE]
> The SSRF guard blocks `100.64/10`, which is Tailscale's own range, so link
> previews of pages hosted *on* your tailnet fail closed.
> `STASH_ALLOW_PRIVATE_FETCH=1` is the escape hatch.

## Health

The container ships a healthcheck:

```bash
docker inspect -f '{{.State.Health.Status}}' kothai
```

It reports **liveness, not model readiness** — the container is `healthy` as
soon as the HTTP server answers, including while models are still downloading
and when no models are configured at all. For model state, use the API:

```bash
curl -s localhost:5173/api/status
```

## Troubleshooting

**Container exits immediately on a Raspberry Pi or under emulation.** Almost
certainly the ARM SVE issue: one of the QVAC native prebuilds is compiled with
SVE instructions that `SIGILL` on CPUs without them, taking the worker down at
startup. The image ships a stub to avoid it, so make sure you are on a current
image (`docker compose pull`) rather than a locally built old one.

**Killed, or the container restarts during model loading.** Out of memory. Check
with `docker inspect -f '{{.State.OOMKilled}}' kothai`. In Settings, switch the
language model to **Off** for immediate relief — On demand only frees RAM
after several idle minutes, so it won't help mid-crisis — then pick smaller
models or turn off image captioning before switching back to On demand. See
"Choosing how much RAM Kothai uses" above. Adding RAM is the last resort, not
the first.

**First boot takes a very long time.** Expected — it is fetching 3+ GB for the
default setup, less if you picked lighter models.
Watch it with `docker compose logs -f`. The UI works throughout.

**Permission denied writing to data.** The entrypoint repairs ownership at
startup, but only when it starts as root. If you pass `--user`, make sure that
user owns `./data` and `./models` on the host.

**Port already in use.** Change the host side of the mapping in
`docker-compose.yml`, e.g. `"8080:5173"`, or set `PORT`.

## Notes on security

Kothai is designed as a **single-user personal app**. `STASH_PASSWORD` gates the
whole app when set, and outbound link-preview fetches are guarded against SSRF —
but there is no per-user separation, no rate limiting outside login, and no
encryption at rest.

On a private network or a tailnet, running without a password is fine. On a
public hostname, set one and put TLS in front.

Full threat model, what each guard actually covers, and what is deliberately
left unprotected: **[security.md](security.md)**.
