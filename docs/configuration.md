# Configuration

All settings are optional. The defaults are what the image ships with.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `5173` | HTTP port. Leave it alone under Docker and change the host side of the port mapping instead. |
| `KOTHAI_HOME` | *(unset)* | Root for the data path below. Useful on hosts that allow only one volume. |
| `KOTHAI_DATA_DIR` | `<app>/data` | Notes, chats, settings, uploads. |
| `KOTHAI_AI_BASE_URL` | *(unset)* | OpenAI-compatible endpoint URL, e.g. `http://ollama:11434/v1`. Serves every role unless a role has its own. |
| `KOTHAI_AI_API_KEY` | *(unset)* | Bearer token for that endpoint. Not needed for Ollama. |
| `KOTHAI_AI_VISION_BASE_URL`, `KOTHAI_AI_VISION_API_KEY` | *(unset)* | A separate endpoint and key for vision. |
| `KOTHAI_AI_EMBED_BASE_URL`, `KOTHAI_AI_EMBED_API_KEY` | *(unset)* | A separate endpoint and key for embeddings. |
| `KOTHAI_AI_LLM_MODEL`, `KOTHAI_AI_VISION_MODEL`, `KOTHAI_AI_EMBED_MODEL` | *(unset)* | Pin a role's model name. Wins over Settings. |
| `KOTHAI_PASSWORD` | *(unset)* | Require this password before anything is served. Unset means no auth. Set it before exposing Kothai publicly. |
| `KOTHAI_GOOGLE_CLIENT_ID` | *(unset)* | The Google OAuth client that *Google Drive* backups sign in through. Needs `KOTHAI_GOOGLE_CLIENT_SECRET` too; either alone counts as unset. See [Backups](./backups.md#google-drive). |
| `KOTHAI_GOOGLE_CLIENT_SECRET` | *(unset)* | That client's secret. |
| `KOTHAI_ALLOW_PRIVATE_FETCH` | *(unset)* | Set to `1` to let link previews reach private/loopback addresses. Off by default as an SSRF guard. Enable only on a trusted network where you stash intranet links. |

A specific variable wins over `KOTHAI_HOME`, which wins over the default.

If any `*_BASE_URL` variable is set, the credential file is ignored entirely, and a role URL without its own key gets no key. See [Models & inference](models.md#per-role-endpoints).

## RAM usage

Kothai itself needs about 300 MB. Models run on whatever endpoint you point it at, so their memory is that host's, not Kothai's. Saving works with every role off. Pick "Skip for now" during setup to run Kothai as a plain bookmark manager and connect an endpoint later. See [Models & inference](models.md).

## What lives where

| Path | Contents | Back up? |
|---|---|---|
| `./data` | `kothai.db`, `uploads/`, `backups/`, and `credentials.json` if you entered an API key in the app (plain text), `google-drive.json` if you connected Google Drive | **Yes** |
