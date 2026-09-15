<div align="center">

<img src="public/logo.png" alt="Kothai" width="120">

### Save now. Remember later.

Everything you save gets read and filed by a model running on your own machine.
Later you ask it questions in plain English, and it answers from your own stuff
rather than the open web.

[Quick start](#quick-start) · [How it works](#how-it-works) · [Documentation](#if-you-want-to) · [Self-hosting](docs/self-hosting.md) · [API](docs/api.md)

[![release](https://img.shields.io/github/v/tag/IbrahimTareq/kothai?style=flat-square&label=release&labelColor=1a1a1a&color=blue)](https://github.com/IbrahimTareq/kothai/releases)
[![image](https://img.shields.io/badge/ghcr.io-kothai-2496ed?style=flat-square&logo=docker&logoColor=white&labelColor=1a1a1a)](https://github.com/IbrahimTareq/kothai/pkgs/container/kothai)
[![qvac](https://img.shields.io/badge/tether-qvac-14E4C2?style=flat-square&logo=tether&logoColor=white&labelColor=1a1a1a)](https://github.com/tetherto/qvac)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square&labelColor=1a1a1a)](LICENSE)
[![last commit](https://img.shields.io/github/last-commit/IbrahimTareq/kothai?style=flat-square&labelColor=1a1a1a)](https://github.com/IbrahimTareq/kothai/commits/main)

`your data stays yours` · `no account` · `no telemetry` · `runs on a Raspberry Pi`

<!-- Demo GIF goes here. Record the capture, enrich and ask loop, drop it in
     docs/assets/demo.gif, and uncomment:
<img src="docs/assets/demo.gif" alt="Capture, enrich, ask" width="720">
-->

</div>

---

Saving is a solved problem. Every app has a bookmark button and every chat has
a note to self. What never works is coming back three weeks later and actually
finding the thing again.

Kothai is the finding half. You throw links, screenshots and half-formed
thoughts at one box. Each one shows up straight away, and a local model reads it
in the background: gives it a title, writes a summary, picks tags then turns it
into a vector so you can search by meaning instead of exact words. Weeks later
you flip the same box into Ask and put questions to the pile. Answers are built
only from what you saved and every claim points back at the card it came from.

In case you're wondering, Kothai is Bengali for "where". It's the question you end up asking
when you're trying to find something which is the problem this is built around.

## Features

- **Two-phase saving.** A card appears the moment you hit Enter, and the models catch up in the background. The UI never sits waiting on inference.
- **Ask your archive.** Cosine similarity and keyword search both run, and the top cards go to the language model. It has to cite each one by number. If nothing matches, it says so instead of making something up.
- **Images count as notes.** Drop a screenshot and a vision model writes a caption for it, so it shows up in search like anything else.
- **Links turn into cards.** Page metadata gets fetched once and cached. YouTube captions and full article text come along too, which makes videos and long reads far easier to find later.
- **Spaces.** Collections of items, optionally with a tag rule that files matching notes automatically. Any Space can be opened as a freeform canvas: drag cards around, write notes, stack things in columns and draw lines between them.
- **Swappable models.** Three slots, all changeable while the app is running. Swap the embedding model and the library re-indexes itself.
- **Tunable memory.** Each model role can be always on, on demand, or off. Turn all three off and you have a working bookmark manager on a 1 GB box.
- **Runs on modest hardware.** A Raspberry Pi 5 handles the small models fine. There's also a lite image — 475 MB on disk, no model weights — that does no inference itself and talks to any OpenAI-compatible endpoint.
- **Your data stays yours.** One SQLite file on disk, JSON export in a click, and hot database backups that need no downtime. No account, no telemetry.

## Quick start

```bash
curl -fsSL https://ibrahimtareq.github.io/kothai/install.sh | sh
```

It asks two questions, pulls the right image, waits until it actually answers,
and opens the browser.

```
  Where should the AI run?

    1) A cloud service — nothing to download, needs an API key
    2) On this machine — private, no key, no bills, ~3 GB
  > 1

  Which one?

    1) OpenAI
    2) OpenRouter — many models behind one key
  > 1

  Pulling ghcr.io/ibrahimtareq/kothai:lite — this is the slow part.
  Ready — http://localhost:5173
```

Paste your key in the browser, press Start. That's the whole setup — the model
names are filled in for you and the key never touches your shell history.

Those two questions exist because they pick the image, which is the one choice
that cannot be made later. Everything else is a screen in the app.

Both services on that second list do the whole job — chat, images and search by
meaning — so either way nothing downloads. Anything else you want to point at,
including a chat-only service or your own server, is `--endpoint URL` or
`STASH_AI_BASE_URL`; see [Bring your own AI](#bring-your-own-ai--lighter).

`--lite`, `--local`, `--endpoint URL`, `--port N`, `--dir PATH`, `--password …`
answer up front and skip the questions entirely; `--help` lists them. With no
terminal at all — CI, a Dockerfile, a NAS UI — nothing is asked.

It leaves a `kothai` command behind too:

```bash
kothai start · stop · restart · status · logs · update · uninstall
```

`update` pulls the newest image and recreates the container with the settings
it already has. `uninstall` removes the container and never your data. Pass
`--no-shim` to the installer if you would rather not have the command.

The two sections below are what it runs. Read them instead if you would rather
type it yourself, or paste it into Portainer, Dockge or a NAS UI.

### Bring your own AI — lighter

Nothing downloads and nothing runs on your hardware, so a NAS or a 1 GB box is
plenty. You need an API key from a service that speaks the OpenAI format.

```bash
docker run -d --name kothai -p 5173:5173 -v ./data:/app/data \
  ghcr.io/ibrahimtareq/kothai:lite
```

Open <http://localhost:5173>, pick your provider, paste the key. 475 MB, about
300 MB of RAM.

One catch decides which image you want, and it only matters for endpoints the
installer does not offer. Several hosted chat services — Ollama Cloud, Groq,
Anthropic — serve no embeddings at all, and embeddings are what make search work
by meaning rather than by exact words. Point at one of those and you want the
full image, where Kothai keeps a small (~300 MB) embedding model on your machine
while the language and vision work goes out:

```bash
docker run -d --name kothai -p 5173:5173 -v ./data:/app/data -v ./models:/app/models \
  ghcr.io/ibrahimtareq/kothai:latest
```

OpenAI, OpenRouter, a self-hosted Ollama, llama.cpp server and vLLM all serve
embeddings, so `:lite` is enough for those — which is why the installer offers
only endpoints of that kind, and picks the image for you.

For anything else, name it yourself:

```bash
curl -fsSL https://ibrahimtareq.github.io/kothai/install.sh | sh -s -- \
  --endpoint https://api.groq.com/openai/v1 --key …
```

You can still set the endpoint with environment variables rather than in the
browser — `STASH_AI_PROVIDER=remote`, `STASH_AI_BASE_URL`, `STASH_AI_API_KEY` —
and those win over anything set in the app. See
[Self-hosting](docs/self-hosting.md).

### Everything baked in — heavier

Models included, nothing leaves the box, nothing to sign up for.

```bash
docker run -d --name kothai -p 5173:5173 -v ./data:/app/data -v ./models:/app/models \
  ghcr.io/ibrahimtareq/kothai:latest
```

Open <http://localhost:5173> and pick your models. 8 GB of RAM and 6 GB of free
disk is comfortable; a Pi 5 or a 4 GB VPS works too, as long as you pick the
light models when it asks.

Add `-e STASH_PASSWORD=…` to require a password, and change the left half of
`-p 5173:5173` if that port is taken. There's a `docker-compose.yml` in the repo
if you'd rather run it that way — see [Self-hosting](docs/self-hosting.md).

### From source

If you want to work on it. No Docker, Node 22 on the host, and the same RAM and
disk story as the baked-in setup above:

```bash
git clone https://github.com/IbrahimTareq/kothai.git
cd kothai
corepack enable      # provides the pnpm version pinned in package.json
pnpm install
pnpm start           # builds the client, then serves on :5173
```

`pnpm dev` runs both the server and Vite instead, and you develop against
:5174 with HMR. The test suite, the two ports and the conventions are in
[Development](docs/development.md).

### First run

Open <http://localhost:5173>. If you connected a service you paste your key and
you are done; if the models run here, pick them or hit *Skip for now* and turn
them on later. Weights download in the background, so keep pasting while they
do: anything saved meanwhile gets its title and tags from a quick
heuristic, then gets properly enriched once the bar says Ready. That's when Ask
starts working too.

HTTPS, backups, upgrades and the rest of the hosting story are in
[Self-hosting](docs/self-hosting.md).

## How it works

Everything else follows from one decision: saving happens in two phases.

Phase one writes the note the moment you hit Enter, guessing its type and title
with cheap regex. Phase two is a background queue that fetches link metadata,
captions images, classifies the note properly and embeds it then patches the
card in place.

Keeping the two apart is what makes the rest work. The UI never waits on a
model. A model that's slow, still downloading or switched off leaves you with
the phase-one version rather than an error. And pasting twenty links at once
doesn't have them fighting over the same weights.

## If you want to…

| | … then read |
|---|---|
| **understand how it works** before changing anything | [Architecture](docs/architecture.md) |
| **set up a dev environment** and run the tests | [Development](docs/development.md) |
| **add a route, an importer, or a model preset** | [Development → Recipes](docs/development.md#recipes) |
| **call the API** from a script or another client | [HTTP API](docs/api.md) |
| **understand the AI layer**: roles, residency, RAM | [Models & inference](docs/models.md) |
| **run it on your own hardware** | [Self-hosting](docs/self-hosting.md) |
| **expose it beyond your LAN** | [Security](docs/security.md) |
| **touch any CSS** | [Design system](docs/design-system.md) |

## Contributing

Issues and PRs are welcome. The server stays thin on purpose: no framework, no
ORM, no build step. Open an issue first for anything sizeable so we can agree on
the shape. AI-assisted PRs are fine as long as a human has actually read them. The conventions worth knowing before you write code are in
[docs/development.md](docs/development.md#conventions).

## License

Released under [AGPL-3.0](LICENSE).
