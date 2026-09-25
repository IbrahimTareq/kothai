# Import

Import data from other services.

## POST /api/import

Imports one or more export files, sent as a JSON body (`Content-Type:
application/json`) with each file base64-encoded. Multipart form data is not
accepted: with `KOTHAI_PASSWORD` set, any mutation that is not
`application/json` is rejected with `415 content_type_required`.

<TypeTable
  type={{
    source: {
      description: 'Importer to check the upload against: `instagram` or `tiktok`. Omit to detect it from the files.',
      type: 'string',
    },
    files: {
      description: 'Files to import. `data` is the file base64-encoded, raw or as a data URL. A ZIP is unpacked; anything else is read as a single JSON file.',
      type: '{ name: string, data: string }[]',
      required: true,
    },
  }}
/>

A single file can also be sent as top-level `{ name, data }` in place of
`files`.

Maximum 20 files per request, and 64 MB for the whole JSON body (`413`
beyond that). ZIPs in one request share a 512 MB decompression budget.

Returns `400 import_source_mismatch` if the files don't match `source`, and
`409 import_in_progress` if another import is already running.

On success, returns `{ importer, imported, skipped, failed, collections,
warnings }`.
