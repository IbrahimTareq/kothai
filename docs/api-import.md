# Import

Import data from other services.

## POST /api/import

Multi-file upload for importing data from other services.

<TypeTable
  type={{
    files: {
      description: 'Files to import (multipart form data)',
      type: 'File[]',
      required: true,
    },
  }}
/>

Maximum 20 files per request.

Returns `409 import_in_progress` if another import is already running.
