<div align="center">

<img src="public/logo.svg" alt="Kothai" width="120">

### Save now. Remember later.

A self-hosted bookmark and note manager with local AI.

[Documentation](https://getkothai.com/docs/getting-started/what-is-kothai) · [Quick start](#quick-start) · [API](https://getkothai.com/docs/reference/api/api-auth)

[![release](https://img.shields.io/github/v/tag/IbrahimTareq/kothai?style=flat-square&label=release&labelColor=1a1a1a&color=blue)](https://github.com/IbrahimTareq/kothai/releases)
[![image](https://img.shields.io/badge/ghcr.io-kothai-2496ed?style=flat-square&logo=docker&logoColor=white&labelColor=1a1a1a)](https://github.com/IbrahimTareq/kothai/pkgs/container/kothai)
[![qvac](https://img.shields.io/badge/tether-qvac-14E4C2?style=flat-square&logo=tether&logoColor=white&labelColor=1a1a1a)](https://github.com/tetherto/qvac)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square&labelColor=1a1a1a)](LICENSE)

`your data stays yours` · `no account` · `no telemetry` · `runs on a Raspberry Pi`

</div>

---

You throw links, screenshots and half-formed thoughts at one box. A local model reads each one in the background, gives it a title, picks tags, and turns it into a vector so you can search by meaning instead of exact words. Flip it into Ask and put questions to the pile. Answers are built only from what you saved, and every claim points back at the card it came from.

See [What is Kothai?](https://getkothai.com/docs/getting-started/what-is-kothai) for the full feature list.

## Quick start

```bash
curl -fsSL https://getkothai.com/install.sh | sh
```

The script asks two questions (where should AI run, which service), pulls the right image, and opens the browser. Pass `--help` to see all flags.

Or run it directly:

```bash
# Remote inference (lite, ~475 MB)
docker run -d --name kothai -p 5173:5173 -v ./data:/app/data \
  ghcr.io/ibrahimtareq/kothai:lite

# Local models (full, ~2.2 GB + model weights)
docker run -d --name kothai -p 5173:5173 -v ./data:/app/data -v ./models:/app/models \
  ghcr.io/ibrahimtareq/kothai:latest
```

Open <http://localhost:5173> and follow the setup screen.

**Next steps:** [Configuration](https://getkothai.com/docs/getting-started/configuration) · [Remote access](https://getkothai.com/docs/running-it/remote-access) · [Backups](https://getkothai.com/docs/running-it/backups) · [More ways to start](https://getkothai.com/docs/getting-started/more-ways-to-start)

## How it works

Saving runs in two phases. Phase one writes the note immediately with cheap regex guesses. Phase two is a background queue that fetches metadata, captions images, classifies, and embeds. The UI never waits on a model, and a model that's off or still downloading leaves you with the phase-one version rather than an error.

Read more: [Architecture](https://getkothai.com/docs/how-it-works/architecture) · [Models & inference](https://getkothai.com/docs/how-it-works/models) · [Security](https://getkothai.com/docs/how-it-works/security)

## Development

```bash
git clone https://github.com/IbrahimTareq/kothai.git
cd kothai && corepack enable && pnpm install
pnpm dev    # server on :5173, Vite HMR on :5174
pnpm test   # 1142 tests, ~5s
```

See the full [Development guide](https://getkothai.com/docs/getting-started/development).

## Contributing

Issues and PRs are welcome. The server stays thin on purpose: no framework, no ORM, no build step. Open an issue first for anything sizeable so we can agree on the shape. AI-assisted PRs are fine as long as a human has actually read them.

## License

Released under [AGPL-3.0](LICENSE).
