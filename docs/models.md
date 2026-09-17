# Models & inference

## The three roles

| Role | Powers | When it's off |
|---|---|---|
| **Language** | Classification, titles, tags, Ask answers | Notes keep their heuristic title; Ask is disabled |
| **Embedding** | Semantic search, Ask retrieval | Ask falls back to keyword search |
| **Vision** | Image captions, thumbnail descriptions | Images are saved but not described |

All three are optional. With every role off, Kothai is a working bookmark manager on about 1 GB.

## Residency

Each role has a residency policy set in Settings → Model Cores:

| Policy | Behaviour |
|---|---|
| **Always on** | Loaded at boot, never unloaded. Fastest, most RAM. |
| **On demand** | Loaded on first use, unloaded after idle. |
| **Off** | Never downloaded or loaded. |

| Setup | RAM |
|---|---|
| Everything off | ~1 GB |
| **Default** (embedding always, others on demand) | ~1.5 GB idle |
| Everything always-on, largest models | 9+ GB |

## Presets

| Slot | Default | Light (Pi) | Roomy (Apple Silicon) |
|---|---|---|---|
| **Language** | Qwen3 1.7B | Qwen3 0.6B | Qwen3 4B |
| **Embedding** | EmbeddingGemma Q8 | EmbeddingGemma Q4 | GTE Large |
| **Vision** | Qwen3.5-VL 2B | SmolVLM2 0.5B | Qwen3.5-VL 4B |

All three are swappable live from Settings.

## Remote inference

```bash
KOTHAI_AI_PROVIDER=remote
KOTHAI_AI_BASE_URL=http://localhost:11434/v1
KOTHAI_AI_API_KEY=…        # not needed for Ollama
```

Model names are picked in Settings. Credentials are env-only and never written to SQLite.

### Remote defaults

When you pick a provider during setup, Kothai pre-fills models that are known to work for all three roles. You can change them at any time in Settings.

| Provider | Language | Embedding | Vision |
|---|---|---|---|
| **OpenAI** | gpt-4o-mini | text-embedding-3-small | gpt-4o-mini |
| **OpenRouter** | openai/gpt-4o-mini | openai/text-embedding-3-small | openai/gpt-4o-mini |
| **Ollama (local)** | llama3.2:3b | nomic-embed-text | llama3.2-vision |

These defaults favour the cheapest models that cover all three roles. Any model the endpoint serves can be used instead.
