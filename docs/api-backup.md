# Backup

Export data, back up and restore the library, and wipe the instance.

## GET /api/export

Returns a JSON export of all notes, Spaces, and chats.

## GET /api/backup

Returns the whole library as a `.tar.gz`: a hot snapshot of the database (`kothai.db`) and every uploaded file (`uploads/…`). Safe while Kothai is running. Credentials are never in it.

## POST /api/restore

Replaces the library with a backup's. Send the file itself as the body, with `Content-Type: application/octet-stream`. Takes a `.tar.gz` from `GET /api/backup`, or a bare `.db` from older versions (which leaves the uploads on disk alone).

Replaces notes, spaces, chats and uploads. Model settings stay as they are on this install. The library being replaced is first saved to `data/backups/before-restore-<time>.tar.gz`.

Returns `{ restored: { notes, collections, chats }, savedAs }`. Answers `400` (`bad_backup`) for a file that is not a backup or holds a damaged database, with nothing replaced; `409` while an import is running; `415` without the octet-stream content type.

## GET /api/backups

Lists the backups kept in `data/backups`: `{ enabled, files: [{ name, kind, at, size }], failure }`. `kind` is `daily` or `before-restore`; `failure` is why the last daily backup did not happen (`{ at, error }`), or `null`.

## PATCH /api/backups

Turns the daily backup on or off: `{ "enabled": false }`. Answers the same shape as `GET`.

## GET /api/backups/:name

Downloads one kept backup. Only a name from the listing is served.

## GET /api/drive

Google Drive's state: `{ configured, connected, email, pending, error, failure, backups, listError }`. `pending` is `{ userCode, verificationUrl }` while a sign-in waits for the code to be entered; `backups` lists the daily backups in the **Kothai Backups** folder, newest first (`{ id, name, size, at }`).

## POST /api/drive/connect

Starts Google's device sign-in and answers `{ userCode, verificationUrl }`. The server waits for the code to be entered; poll `GET /api/drive` until `connected`. `409` (`drive_not_configured`) without a Google client.

## DELETE /api/drive

Disconnects: revokes Kothai's access and forgets the token. The backups stay on Drive. Also cancels a sign-in in progress.

## POST /api/drive/restore

Restores the library from a Drive backup: `{ "id": "…" }`, an id from `GET /api/drive`. The same restore as `POST /api/restore`, with the same answers; `400` (`drive_backup_unavailable`) for an id not in the folder.

## POST /api/checkpoint

Flushes pending writes and truncates the WAL. Call this before external backup tools snapshot `data/`.

## POST /api/wipe

<TypeTable
  type={{
    confirm: {
      description: 'Must be exactly the string DELETE',
      type: 'string',
      required: true,
    },
  }}
/>

Permanently deletes all data. The fixed confirmation string guards against accidental wipes.
