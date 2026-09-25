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
