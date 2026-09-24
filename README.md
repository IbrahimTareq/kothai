
<div align="center">

<img src="public/logo.svg" alt="Kothai" width="120">

### Save now. Remember later.

A self-hosted save-all manager with local AI.

[Documentation](https://getkothai.com/docs/getting-started/what-is-kothai) · [Quick start](#quick-start) · [API](https://getkothai.com/docs/reference/api/api-auth)

[![release](https://img.shields.io/github/v/tag/IbrahimTareq/kothai?style=flat-square&label=release&labelColor=1a1a1a&color=blue)](https://github.com/IbrahimTareq/kothai/releases)
[![image](https://img.shields.io/badge/ghcr.io-kothai-2496ed?style=flat-square&logo=docker&logoColor=white&labelColor=1a1a1a)](https://github.com/IbrahimTareq/kothai/pkgs/container/kothai)
[![qvac](https://img.shields.io/badge/tether-qvac-14E4C2?style=flat-square&logo=tether&logoColor=white&labelColor=1a1a1a)](https://github.com/tetherto/qvac)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square&labelColor=1a1a1a)](LICENSE)

</div>

---

You throw links at one box. A local model reads each one in the background, gives it a title, picks tags, and turns it into a vector so you can search by meaning instead of exact words. Flip it into Ask and put questions to the pile. Answers are built only from what you saved, and every claim points back at the card it came from.

## Why Kothai?

- **Save links, find them later.** Articles, videos, posts, repos. A local model reads and indexes each page so you search by meaning, not keywords.
- **Ask your own stuff.** Answers are built only from what you saved, with every claim citing the card it came from.
- **Runs on your hardware.** One container, one SQLite file, no cloud account. A Raspberry Pi 5 handles it.
- **AI is optional.** Use local models, point at any endpoint, or turn it off entirely. Run the models yourself and your data stays on your machine, with Telegram capture below as the one opt-in exception.
- **Capture from your phone.** Message a link to a Telegram bot and it lands in your archive — no app to install, nothing exposed to the internet. Opt-in, and whatever you send it is stored on Telegram's servers too.

See [What is Kothai?](https://getkothai.com/docs/getting-started/what-is-kothai) for the full feature list.

## Quick start

```bash
curl -fsSL https://getkothai.com/install.sh | sh
```

Or deploy to Railway:

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/kothai?referralCode=kothai)

One service on ~300 MB of RAM, pointed at an inference endpoint you bring — OpenAI, OpenRouter, anything OpenAI-compatible that also serves embeddings.

Want nothing leaving your own machines? Self-host with the install script above and point Kothai at Ollama on the same hardware. Railway has no GPUs, so a model hosted there is too slow to be useful.

**Next steps:** [Configuration](https://getkothai.com/docs/getting-started/configuration) · [Remote access](https://getkothai.com/docs/running-it/remote-access) · [Backups](https://getkothai.com/docs/running-it/backups) · [Build from source](https://getkothai.com/docs/getting-started/self-hosting#build-from-source)

## How it works

Saving runs in two phases. Phase one writes the note immediately. Phase two is a background queue that fetches metadata, describes thumbnails, classifies, and embeds. The UI never waits on a model and a model that's off or still downloading leaves you with the phase-one version rather than an error.

Read more: [Architecture](https://getkothai.com/docs/how-it-works/architecture) · [Models & inference](https://getkothai.com/docs/how-it-works/models) · [Security](https://getkothai.com/docs/how-it-works/security)

## Development

```bash
git clone https://github.com/IbrahimTareq/kothai.git
cd kothai && corepack enable && pnpm install
pnpm dev    # server on :5173, Vite HMR on :5174
pnpm test   # the full gate, ~5s
```

See the full [Development guide](docs/development.md).

## Contributing

Issues and PRs are welcome. The server stays thin on purpose: no framework, no ORM, no build step. Open an issue first for anything sizeable so we can agree on the shape. AI-assisted PRs are fine as long as a human has actually read them.

## License

Released under [AGPL-3.0](LICENSE).