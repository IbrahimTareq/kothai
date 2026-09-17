# Chats

Manage chat conversation history.

## GET /api/chats

Returns a paged list of chat conversations.

## GET /api/chats/:id

Returns a single chat by id.

## PATCH /api/chats/:id

<TypeTable
  type={{
    title: {
      description: 'New title for the chat',
      type: 'string',
    },
  }}
/>

## DELETE /api/chats/:id

Deletes the chat and its messages.
