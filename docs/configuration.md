# Configuration

All settings are optional. The defaults are what the image ships with.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `5173` | HTTP port. |
| `STASH_HOME` | *(unset)* | Root for the three paths below. Useful on hosts that allow only one volume. |
| `STASH_DATA_DIR` | `<app>/data` | Notes, chats, settings, uploads. |
| `STASH_MODELS_DIR` | `<app>/models` | Model weights. |
| `STASH_AI_PROVIDER` | `local` | `local` runs models on-device. `remote` sends them to an inference endpoint. |
| `STASH_AI_BASE_URL` | *(unset)* | Endpoint URL, e.g. `http://ollama:11434/v1`. Remote only. |
| `STASH_AI_API_KEY` | *(unset)* | Bearer token for the endpoint. Not needed for Ollama. |
| `STASH_PASSWORD` | *(unset)* | Require this password before anything is served. Unset means no auth. Set it before exposing Kothai publicly. |

A specific variable wins over `STASH_HOME`, which wins over the default.

## RAM usage

Kothai has three model roles (Language, Embedding, Vision), each with a residency policy you control in **Settings → Model Cores**. See [Models & inference](models.md) for what each role does and the RAM trade-offs.

The default is embedding always-on (~300 MB) with language and vision on demand. Saving works with everything off. Pick "Skip for now" during setup to run Kothai as a plain bookmark manager and enable models later.

## What lives where

| Path | Contents | Back up? |
|---|---|---|
| `./data` | `kothai.db` and `uploads/` | **Yes** |
| `./models` | Model weights | No, they re-download |
