# More ways to start

## Build from source

Instead of pulling the published image, uncomment `build: .` in `docker-compose.yml`, then:

```bash
docker compose up -d --build
```

## Bare metal

No container:

```bash
git clone https://github.com/IbrahimTareq/kothai.git
cd kothai
corepack enable          # provides the pnpm version pinned in package.json
pnpm install
pnpm start
```

## ONCE

[ONCE](https://github.com/basecamp/once) is Basecamp's self-hosting installer. It installs Docker if the machine doesn't have it, gets a TLS certificate, keeps the app updated and runs scheduled backups, all from one dashboard. If you're putting Kothai on a VPS, this is the shortest path. It replaces the reverse-proxy setup and the upgrade and backup sections below.

```bash
curl https://get.once.com | sh
```

Then point it at `ghcr.io/ibrahimtareq/kothai:once` and give it a hostname. Budget the same RAM as any other install. ONCE makes setup easier, not the models smaller.

The `:once` tag is the full image with the three defaults ONCE requires already set (`PORT=80`, `KOTHAI_HOME=/storage`, a `/up` healthcheck), because ONCE installs an image by name and has nowhere to put environment variables. It's the same build as `:latest` otherwise.

> [!IMPORTANT]
> ONCE handles TLS but adds no authentication of its own, and it gives Kothai a public hostname. Set `KOTHAI_PASSWORD`.

Kothai ships a `pre-backup` hook, so ONCE's scheduled backups run `POST /api/checkpoint` first and archive a database that restores cleanly. See [Snapshot backups](backups.md#snapshot-backups-restic-borg-once) for what that solves. There's no `post-restore` hook on purpose: with the WAL already truncated at backup time, putting the files back is all a restore needs. A hook that deleted `-wal`/`-shm` could throw away committed data.