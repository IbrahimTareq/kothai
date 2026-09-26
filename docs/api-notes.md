# Notes

Create, list, update, and delete notes.

## POST /api/save

```json
{ "text": "https://example.com" }
```

<TypeTable
  type={{
    text: {
      description: 'The http(s) link to save. Anything else is refused with a 400 and `code: "links_only"`.',
      type: 'string',
    },
  }}
/>

**Response:**

```json
{ "note": { "id": "...", "type": "link", "pending": true } }
```

Returns immediately. Enrichment runs in the background.

`pending` stays `true` until the note's labelling pass has run. For an
Instagram post that pass waits for its caption fetch, which runs on a
throttled lane, so a large import's posts stay pending until that lane
reaches them.

## GET /api/notes

<TypeTable
  type={{
    q: {
      description: 'Substring search',
      type: 'string',
    },
    type: {
      description: 'Filter by note type',
      type: '"link" | "video"',
    },
    source: {
      description: 'Filter by source platform',
      type: '"github" | "reels" | "tiktok" | "reddit" | "web"',
    },
    collection: {
      description: 'Filter by Space id',
      type: 'string',
    },
    offset: {
      description: 'Pagination offset',
      type: 'number',
      default: 0,
    },
    limit: {
      description: 'Max results per page',
      type: 'number',
      default: 120,
    },
  }}
/>

## GET /api/notes/delta

<TypeTable
  type={{
    since: {
      description: 'Revision number to sync from',
      type: 'number',
      required: true,
    },
    boot: {
      description: 'Boot id for sync continuity',
      type: 'string',
    },
  }}
/>

Returns notes changed since `since`. If `resync: true` in response, refetch everything.

## Other endpoints

| Endpoint | Description |
|---|---|
| `GET /api/notes/:id` | Single note by id |
| `PATCH /api/notes/:id` | Update `{ tags?, title?, mindNote? }` |
| `DELETE /api/notes/:id` | Delete note |
