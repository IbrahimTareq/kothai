# Models & inference

Kothai runs no models itself. Every role calls an OpenAI-compatible endpoint: a hosted one (OpenAI, OpenRouter) or one you run (Ollama, llama.cpp, vLLM).

## The three roles

| Role | Powers | When it's off |
|---|---|---|
| **Language** | Classification, titles, tags, Ask answers | Notes keep their heuristic title; Ask is disabled |
| **Embedding** | Semantic search, Ask retrieval | Search is keyword-only |
| **Vision** | Image captions, thumbnail descriptions | Images are saved but not described |

All three are optional. With every role off, Kothai is a working bookmark manager on about 300 MB.

## Connecting an endpoint

Pick a provider during setup or in Settings and paste the key there. Model names are picked in Settings; clear one to switch that role off. A key entered in the app is kept in `data/credentials.json`, outside the database but in plain text, so any backup of `data/` carries it.

Or set it by environment variable:

```bash
KOTHAI_AI_BASE_URL=http://localhost:11434/v1
KOTHAI_AI_API_KEY=…        # not needed for Ollama
```

## Per-role endpoints

By default one endpoint serves every role. Vision and embedding can each point somewhere else, for example chat on Claude and embeddings on OpenAI:

| Variable | Role |
|---|---|
| `KOTHAI_AI_BASE_URL`, `KOTHAI_AI_API_KEY` | Language, and the other two unless they have their own |
| `KOTHAI_AI_VISION_BASE_URL`, `KOTHAI_AI_VISION_API_KEY` | Vision |
| `KOTHAI_AI_EMBED_BASE_URL`, `KOTHAI_AI_EMBED_API_KEY` | Embedding |
| `KOTHAI_AI_LLM_MODEL`, `KOTHAI_AI_VISION_MODEL`, `KOTHAI_AI_EMBED_MODEL` | Model names, instead of picking them in Settings |

Three rules, each there so a key never reaches a host you didn't choose:

- If any `*_BASE_URL` variable is set, the credential file is ignored entirely. The environment is the whole configuration.
- A role URL set without its own key gets no key. It does not borrow the shared one.
- A model name set by environment wins over Settings, and Settings shows it read-only.

## Claude

Anthropic has no embeddings endpoint. Pick Claude for chat and Kothai needs a separate embeddings provider (OpenAI, OpenRouter, Ollama) for the embedding role. Until one is set, search is keyword-only.

## Remote defaults

When you pick a provider during setup, Kothai pre-fills models known to work on it. You can change them at any time in Settings.

| Provider | Language | Embedding | Vision |
|---|---|---|---|
| **OpenAI** | gpt-4o-mini | text-embedding-3-small | gpt-4.1-mini |
| **OpenRouter** | openai/gpt-4o-mini | openai/text-embedding-3-small | openai/gpt-4.1-mini |
| **Ollama (local)** | llama3.2:3b | nomic-embed-text | llama3.2-vision |

These defaults favour the cheapest models that cover the roles the endpoint can fill. Cheapest means per job, not per token: gpt-4o-mini costs less per word but bills a reel cover at roughly 25,000 tokens, so vision uses gpt-4.1-mini, which reads the same cover for about 830. Any model it serves can be used instead.

## Ollama

To keep inference on your own machine, add Ollama to the compose file:

```bash
docker compose --profile ollama up -d
docker compose exec ollama ollama pull llama3.2:3b
docker compose exec ollama ollama pull nomic-embed-text
```

Then pick Ollama during setup. The endpoint is `http://ollama:11434/v1`, the service name, because Kothai reaches it over the compose network. The installer's `--local` flag does the same. Ollama runs on CPU as it stands; for an NVIDIA GPU add a device reservation, per Ollama's Docker docs. If Kothai can't reach it, see [Troubleshooting](troubleshooting.md).

On Railway, use a hosted endpoint. Railway has no GPUs, and a model on its shared CPU takes close to a minute to tag a single note, and captioning images there is impractical. If you want nothing to leave your own machines, self-host Kothai and run Ollama on your own hardware instead.

## Upgrading from on-device models

Earlier versions ran models inside the container. That is gone. An upgraded install keeps every note and opens with a banner. Search is keyword-only until you connect an embeddings endpoint, then Kothai re-embeds your library once in the background. A note the endpoint refuses during that pass loses its old vector and is found by keyword. You can delete `./models`.
