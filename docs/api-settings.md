# Settings

Model selection, status, and first-run configuration.

## GET /api/status

Returns model load state and download progress.

If `configured: false`, show the first-run model picker.

## GET /api/settings

Returns current model selection, residency settings, and available presets.

## POST /api/settings

Updates model selection or residency settings.

## POST /api/setup

First-run only.

<TypeTable
  type={{
    skip: {
      description: 'Set to true for AI-free mode',
      type: 'boolean',
    },
  }}
/>

If `skip` is not true, provide the model selection instead.
