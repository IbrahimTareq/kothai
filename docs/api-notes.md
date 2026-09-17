# Notes

Create, list, update, and delete notes.

## POST /api/save

```json
{ "text": "https://example.com", "image": "data:image/png;base64,..." }
```

<TypeTable
  type={{
    text: {
      description: 'URL or plain text to save',
      type: 'string',
    },
    image: {
      description: 'Base64-encoded image data',
      type: 'string',
    },
  }}
/>

**Response:**

```json
{ "note": { "id": "...", "type": "link", "pending": true } }
```

Returns immediately. Enrichment runs in the background.

## GET /api/notes

<TypeTable
  type={{
    q: {
      description: 'Substring search',
      type: 'string',
    },
    type: {
      description: 'Filter by note type',
      type: '"link" | "image" | "video" | "code" | "note"',
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
