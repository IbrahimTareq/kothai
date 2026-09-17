# Spaces

Manage Spaces (collections) and their contents.

## GET /api/collections

Returns all Spaces.

## POST /api/collections

<TypeTable
  type={{
    name: {
      description: 'Name of the Space',
      type: 'string',
      required: true,
    },
    tags: {
      description: 'Optional tags to filter by',
      type: 'string[]',
    },
  }}
/>

## PATCH /api/collections/:id

<TypeTable
  type={{
    name: {
      description: 'New name',
      type: 'string',
    },
    tags: {
      description: 'Updated tag filters',
      type: 'string[]',
    },
    canvas: {
      description: 'Canvas layout data',
      type: 'object',
    },
  }}
/>

## DELETE /api/collections/:id

Deletes the Space. Notes in it are not deleted.

## POST /api/collections/:id/items

<TypeTable
  type={{
    itemId: {
      description: 'Note id to add to the Space',
      type: 'string',
      required: true,
    },
  }}
/>

## DELETE /api/collections/:id/items/:itemId

Removes a note from the Space without deleting the note itself.
