# Settings

Model selection, status, and first-run configuration.

## GET /api/status

Returns AI state. If `configured: false`, show the first-run model picker.

`ai.keywordOnly` is true when the embedding role is off, so search matches keywords only. `ai.upgradeNeeded` is true on an install upgraded from on-device models that has no endpoint connected yet.

## GET /api/settings

Returns the current model selection and endpoints.

<TypeTable
  type={{
    endpoints: {
      description: 'Per role (llm, vision, embed): { configured, host, inherited, providerId }. inherited is true when the role uses the shared endpoint, and also when it has no URL at all. providerId is the catalogue entry, or null.',
      type: 'Record<role, object>',
    },
    endpoint: {
      description: 'The same as endpoints.llm.',
      type: 'object',
    },
    envModels: {
      description: 'Roles whose model name is pinned by environment variable. Flags only, never the names.',
      type: 'Partial<Record<role, true>>',
    },
    catalogue: {
      description: 'The provider tiles offered in the picker.',
      type: 'array',
    },
  }}
/>

## POST /api/settings

Updates model selection.

## POST /api/settings/endpoint

Connects an endpoint. Pass `role` (`embed` or `vision`) to set that role's own endpoint; omit it for the shared one.

## DELETE /api/settings/endpoint

Forgets a stored endpoint. With `role`, forgets only that role's, and it falls back to the shared one.

Both endpoint routes return `409` with `{ error, code: 'env_managed' }` when environment variables manage the endpoint.

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

If `skip` is not true, provide the model selection instead. `POST /api/setup/endpoint` connects an endpoint during setup and also accepts `role`.
