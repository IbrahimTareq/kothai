# Architecture

One Node process serves both the built client and the JSON API on a single port. No framework, no ORM, no build step on the server.

## The two-phase save

**Phase one** runs inside the request. It writes the note using heuristic guesses for type and title. The response returns immediately.

**Phase two** is a background FIFO queue that runs enrichment: fetch metadata, describe the thumbnail, classify, embed.

What this buys:

- The UI never blocks on a model
- Failure degrades (the heuristic version stays in place)
- Models can be absent entirely

## Storage

SQLite through `node:sqlite`. One file: `data/kothai.db`.

Notes are held in an in-memory array as well as on disk, so search stays synchronous. SQLite is the durability layer; the array is the query layer.

## Retrieval

Ask uses **hybrid retrieval**: embedding cosine search combined with keyword search via reciprocal rank fusion. This matters because embeddings are weak on exact tokens and keyword search is weak on paraphrase.

The retrieved cards are the *only* context the language model gets.
