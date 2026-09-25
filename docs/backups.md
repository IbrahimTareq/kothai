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

### Automatic backups

Kothai also backs itself up, once a day, to `data/backups/`. Each one is the same file *Download backup* gives you. The newest 7 are kept, so budget about seven times your library's size for them.

Settings → **YOUR DATA** → *Automatic backups* shows when the last one ran, lists every kept file with a *Download* link, and turns them off. Turn them off if something else already backs up `data/` (restic, a NAS snapshot), or disk space is tight.

- **It never fills the disk.** A backup that would leave less than 256 MB free is skipped, and the reason is shown in Settings.
- **Failures are reported.** If one fails and a Telegram bot is connected, Kothai messages you once, then retries every hour.
- **It is not off-site.** These copies live on the same disk as your library and are lost with it. Download one now and then, especially on a PaaS, where the volume has no other way out.

A restore also saves the library it replaces here (`before-restore-….tar.gz`, newest 3 kept).

### Google Drive

Settings → **YOUR DATA** → *Google Drive* → *Connect Google Drive*. Kothai shows a code; enter it at [google.com/device](https://www.google.com/device) on any device and approve. No redirect back to Kothai is involved, so this works the same on localhost, a tailnet or a PaaS.

After that, each daily backup is also copied to a **Kothai Backups** folder in your Drive, and the newest 7 are kept there.

- **Kothai sees only its own files.** It asks for Google's `drive.file` permission: the files it created, nothing else in your Drive.
- **The files are ordinary backups**, not encrypted: the same `.tar.gz` as *Download backup*. Anyone who can open your Drive can open them.
- **Restoring on a new machine:** install Kothai, connect the same Google account, and pick a backup from *Show backups on Drive*. It goes through the same restore as an uploaded file, and saves the library it replaces first.
- **Disconnecting** revokes Kothai's access and forgets it. The backups stay in your Drive.
- If a copy fails (Google unreachable, access revoked), Settings says why, the connected Telegram bot tells you once, and Kothai retries every hour.

Needs `KOTHAI_GOOGLE_CLIENT_ID` and `KOTHAI_GOOGLE_CLIENT_SECRET`. Without them the row says it isn't set up.

#### Creating the Google client

Once per Google Cloud project, not per install:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Set up the **OAuth consent screen** (Google Auth Platform → Branding and Audience): user type **External**; add the scopes `.../auth/drive.file`, `openid` and `email`.
3. **Publish it to "In production".** While it is in *Testing*, Google expires every refresh token after 7 days, and Drive backups would quietly disconnect each week. `drive.file` is a non-sensitive scope, so publishing needs no security review.
4. Credentials → **Create OAuth client ID** → application type **TVs and Limited Input devices**.
5. Set the client ID and secret as `KOTHAI_GOOGLE_CLIENT_ID` and `KOTHAI_GOOGLE_CLIENT_SECRET`. A device client's secret is not confidential: Google treats these as public clients, since the secret ships inside every copy of the app.

### Restoring a backup

Settings → **YOUR DATA** → *Restore*, and choose the file. Or the endpoint directly:

```bash
curl -f -H 'Content-Type: application/octet-stream' \
  --data-binary @kothai-backup-2026-09-26.tar.gz http://localhost:5173/api/restore
```

It happens while Kothai keeps running:

- **Notes, spaces, chats and uploads** come from the backup.
- **Model settings stay as they are on this install**, since they describe this machine. If the backup's notes were embedded with a different model, they are re-embedded in the background.
- **Your current library is saved first**, to `data/backups/before-restore-<time>.tar.gz`. Restoring the wrong file is undone by downloading that one from *Automatic backups* and restoring it.

*Restore* takes a file from *Download backup*. A tarball of `data/` made the manual way above is restored the manual way too.

A backup from an older version (a bare `.db` file) restores too. It carries no uploads, so the ones already in `data/uploads` are left alone.

A backup is also an ordinary archive: `tar -xzf kothai-backup-….tar.gz` gives you `kothai.db` and `uploads/`, which is exactly the `data/` directory's shape.

## Upgrading

```bash
docker compose pull
docker compose up -d
```

Your data and downloaded models are untouched.
