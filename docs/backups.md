# Backups and upgrades

Your data is one SQLite database and a directory of uploads.

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

Stopping first matters. `kothai.db` runs in WAL mode, so a live database is really three files (`kothai.db`, `-wal`, `-shm`) that need to be copied together in a consistent state.

Any directory-based backup tool (restic, Borg, Time Machine, a NAS snapshot) can point at `./data` directly.

### Without stopping the container

Settings → **YOUR DATA** → *Download backup*, or the endpoint directly:

```bash
curl -fO -J http://localhost:5173/api/backup
```

With `KOTHAI_PASSWORD` set, that answers 401. Log in first and send the session cookie:

```bash
curl -fs -c kothai.cookies -H 'Content-Type: application/json' \
  -d '{"password":"your-password"}' http://localhost:5173/api/login
curl -fO -J -b kothai.cookies http://localhost:5173/api/backup
```

This uses SQLite's `VACUUM INTO`, which reads one consistent snapshot and writes a fresh, compacted database file. No stopping, no three-file dance. Use it on a PaaS where you can't stop the container, or whenever you just want a copy right now.

Two things to know:

- **It's the database only.** `data/uploads/` is not in it. Thumbnails and carousel slides live there, so keep a copy of that directory too.
- It briefly needs free disk space equal to the database's size, and refuses while an import is running.

To restore, stop the container and put the downloaded file in place of `data/kothai.db`, deleting any `kothai.db-wal` and `kothai.db-shm` beside it.

## Upgrading

```bash
docker compose pull
docker compose up -d
```

Your data and downloaded models are untouched.
