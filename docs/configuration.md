# Configuration

All settings are optional. The defaults are what the image ships with.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `5173` | HTTP port. Leave it alone under Docker and change the host side of the port mapping instead. |
| `KOTHAI_HOME` | *(unset)* | Root for the two paths below. Useful on hosts that allow only one volume. |
| `KOTHAI_DATA_DIR` | `<app>/data` | Notes, chats, settings, uploads. |
| `KOTHAI_MODELS_DIR` | `<app>/models` | Model weights. |
| `KOTHAI_AI_BASE_URL` | *(unset)* | Inference endpoint URL, e.g. `http://ollama:11434/v1`. Setting it sends inference there instead of running models on-device. |
| `KOTHAI_AI_API_KEY` | *(unset)* | Bearer token for the endpoint. Not needed for Ollama. |
| `KOTHAI_PASSWORD` | *(unset)* | Require this password before anything is served. Unset means no auth. Set it before exposing Kothai publicly. |
| `KOTHAI_ALLOW_PRIVATE_FETCH` | *(unset)* | Set to `1` to let link previews reach private/loopback addresses. Off by default as an SSRF guard. Enable only on a trusted network where you stash intranet links. |

A specific variable wins over `KOTHAI_HOME`, which wins over the default.

## RAM usage

Kothai has three model roles (Language, Embedding, Vision), each with a residency policy you control in **Settings → Model Cores**. See [Models & inference](models.md) for what each role does and the RAM trade-offs.

The default is embedding always-on (~300 MB) with language and vision on demand. Saving works with everything off. Pick "Skip for now" during setup to run Kothai as a plain bookmark manager and enable models later.

## What lives where

| Path | Contents | Back up? |
|---|---|---|
| `./data` | `kothai.db`, `uploads/`, and `credentials.json` if you entered an API key in the app (plain text) | **Yes** |
| `./models` | Model weights | No, they re-download |
