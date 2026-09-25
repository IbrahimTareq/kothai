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

You get one `.tar.gz` holding the whole library: the database and every uploaded image. The database part uses SQLite's `VACUUM INTO`, which reads one consistent snapshot and writes a fresh, compacted file. No stopping, no three-file dance. Use it on a PaaS where you can't stop the container, or whenever you just want a copy right now.

It briefly needs free disk space equal to the database's size, and refuses while an import is running. Credentials (the AI key, the Telegram bot token) are never in it.

### Restoring a backup

Settings → **YOUR DATA** → *Restore*, and choose the file. Or the endpoint directly:

```bash
curl -f -H 'Content-Type: application/octet-stream' \
  --data-binary @kothai-backup-2026-09-26.tar.gz http://localhost:5173/api/restore
```

It happens while Kothai keeps running:

- **Notes, spaces, chats and uploads** come from the backup.
- **Model settings stay as they are on this install**, since they describe this machine. If the backup's notes were embedded with a different model, they are re-embedded in the background.
- **Your current library is saved first**, to `data/backups/before-restore-<time>.tar.gz`. Restoring the wrong file is undone by restoring that one.

*Restore* takes a file from *Download backup*. A tarball of `data/` made the manual way above is restored the manual way too.

A backup from an older version (a bare `.db` file) restores too. It carries no uploads, so the ones already in `data/uploads` are left alone.

A backup is also an ordinary archive: `tar -xzf kothai-backup-….tar.gz` gives you `kothai.db` and `uploads/`, which is exactly the `data/` directory's shape.

## Upgrading

```bash
docker compose pull
docker compose up -d
```

Your data and downloaded models are untouched.
