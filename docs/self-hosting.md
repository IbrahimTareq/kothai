# Quick start

One container, no database server, no account. Run the models on your own hardware and you don't need an API key either. Point it at a hosted endpoint instead and the only thing that leaves your machine is the inference.

```bash
curl -fsSL https://getkothai.com/install.sh | sh
```

The script starts the container, waits until it serves, and prints the URL. Run with `--help` to see all flags. It also installs a `kothai` command into `/usr/local/bin` (or `~/.local/bin` when that's not writable) with subcommands like `start`, `stop`, `restart`, `status`, `logs`, `update`, and `uninstall`. Pass `--no-shim` to skip it. It never prompts for a password. `kothai update` reads the port, mounts and environment back off the running container, so an API key you passed to `--key` is never copied into a file on your PATH.

Everything below is what the script does, if you'd rather do it yourself.

```bash
docker run -d --name kothai \
  -p 5173:5173 \
  -v ./data:/app/data \
  -v ./models:/app/models \
  --restart unless-stopped \
  ghcr.io/ibrahimtareq/kothai:latest
```

Or with compose. This is the same container plus the options you'll probably want later, already written out and commented:

```bash
curl -O https://raw.githubusercontent.com/IbrahimTareq/kothai/main/docker-compose.yml
docker compose up -d
```

> [!IMPORTANT]
> **There is no login until you set `KOTHAI_PASSWORD`.** Anyone who can reach the port can read and write everything. On your own machine or a home LAN that's fine and is the default. Set a password before Kothai is reachable from anywhere else (a public hostname, a VPS, a forwarded port) and put TLS in front of it. [security.md](security.md) has the threat model.
