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
    parentId: {
      description: 'Id of the Space to create this one inside. Omit for a top-level Space',
      type: 'string',
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
    description: {
      description: 'What the Space is for, up to 500 characters. An empty string clears it',
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
    parentId: {
      description: 'Move the Space inside another. null moves it to the top level',
      type: 'string | null',
    },
  }}
/>

A `parentId` that does not exist, or is the Space itself or one inside it, answers 400.

## DELETE /api/collections/:id

Deletes the Space. Notes in it are not deleted, and Spaces inside it move up to its parent (or to the top level).

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
