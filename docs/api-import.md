# Import

Import data from other services. Kothai reads exports from:

- **Instagram**: `saved_posts.json` and `saved_collections.json`, or the ZIP.
  Collections become spaces.
- **TikTok**: `user_data_tiktok.json`, or the ZIP. Favourites only.
- **Pocket**: `part_000000.csv` (and any further `part_*.csv`), or the ZIP.
- **Raindrop**: the CSV from Settings → Backups → Export. Folders become spaces.
- **Omnivore**: the export ZIP, or the unzipped `metadata_*.json` files plus
  `highlights/*.md` for highlights. Labels become tags.
- **mymind**: `cards.csv`. Only cards with a link are imported; notes and images
  without one are skipped and counted in a warning.

## POST /api/import

Imports one or more export files, sent as a JSON body (`Content-Type:
application/json`) with each file base64-encoded. Multipart form data is not
accepted: with `KOTHAI_PASSWORD` set, any mutation that is not
`application/json` is rejected with `415 content_type_required`.

<TypeTable
  type={{
    source: {
      description: 'Importer to check the upload against: `instagram`, `tiktok`, `pocket`, `raindrop`, `omnivore` or `mymind`. Omit to detect it from the files.',
      type: 'string',
    },
    files: {
      description: 'Files to import. `data` is the file base64-encoded, raw or as a data URL. A ZIP is unpacked; anything else is read as a single JSON, CSV or markdown file.',
      type: '{ name: string, data: string }[]',
      required: true,
    },
  }}
/>

A single file can also be sent as top-level `{ name, data }` in place of
`files`.

Maximum 1000 files per request, and 64 MB for the whole JSON body (`413`
beyond that). ZIPs in one request share a 512 MB decompression budget.

Returns `400 import_source_mismatch` if the files don't match `source`, and
`409 import_in_progress` if another import is already running.

On success, returns `{ importer, imported, skipped, failed, collections,
warnings }`.
