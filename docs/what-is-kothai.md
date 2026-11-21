# What is Kothai?

Kothai is a self-hosted link manager. You drop in links, and it stores everything locally in a single SQLite file. It classifies your links automatically and lets you search by meaning, not just keywords. Ask it a question and it pulls up the relevant cards from your collection to answer. One container, no cloud account, runs on your own hardware.

The AI part is optional. Turn it on and Kothai will extract metadata from links, describe their thumbnails, tag them by topic and embed everything for semantic search. Models run on any OpenAI-compatible endpoint: a hosted one, or Ollama on your own hardware. Or turn AI off entirely and use it as a fast, private bookmark manager. Your data stays on your machine unless you point inference at a hosted endpoint or connect [Telegram capture](telegram.md).

In case you're wondering, Kothai is Bengali for "where". It's the question you end up asking when you're trying to find something, which is the problem this is built around.

## Features

- **Two-phase saving.** A card appears the moment you hit Enter. Models catch up in the background.
- **Ask your archive.** Hybrid retrieval (cosine + keyword), cited answers, no hallucination beyond your data.
- **Links turn into cards.** Metadata, YouTube captions, and full article text get fetched and indexed.
- **Spaces.** Collections with optional tag rules and a freeform canvas view.
- **Swappable models.** Three roles (language, embedding, vision), each on its own endpoint if you like, all changeable live.
- **Runs on modest hardware.** About 300 MB of RAM, since inference happens on the endpoint. A Raspberry Pi 5 is plenty.
- **Your data stays yours.** One SQLite file, JSON export in a click, hot backups with no downtime.
