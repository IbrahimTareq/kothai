# Ask

Question answering with retrieval-augmented generation.

## POST /api/ask

<TypeTable
  type={{
    question: {
      description: 'The question to ask',
      type: 'string',
      required: true,
    },
    image: {
      description: 'Optional base64-encoded image for visual context',
      type: 'string',
    },
    chatId: {
      description: 'Continue an existing chat conversation',
      type: 'string',
    },
  }}
/>

Add `Accept: text/event-stream` header for streaming responses.

Returns `409 llm_off` if the language model is disabled.
