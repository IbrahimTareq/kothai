# Backup

Export data, create database snapshots, and wipe the instance.

## GET /api/export

Returns a JSON export of all notes, Spaces, and chats.

## GET /api/backup

Returns a hot SQLite snapshot of the database. Does not include uploaded files.

## POST /api/checkpoint

Flushes pending writes and truncates the WAL. Call this before external backup tools snapshot `data/`.

## POST /api/wipe

<TypeTable
  type={{
    confirm: {
      description: 'Confirmation token returned by a dry-run call',
      type: 'string',
      required: true,
    },
  }}
/>

Permanently deletes all data. Requires the confirmation token to prevent accidental wipes.
