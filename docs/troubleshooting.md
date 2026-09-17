# Troubleshooting

## Health

The container ships a healthcheck:

```bash
docker inspect -f '{{.State.Health.Status}}' kothai
```

It reports **liveness, not model readiness**. The container is `healthy` as soon as the HTTP server answers, including while models are still downloading. For model state, use the API:

```bash
curl -s localhost:5173/api/status
```

## Common issues

<Accordions>
<Accordion title="Container exits immediately on a Raspberry Pi or under emulation">
Almost certainly the ARM SVE issue. Make sure you're on a current image (`docker compose pull`) rather than a locally built old one.
</Accordion>

<Accordion title="Killed, or the container restarts during model loading">
Out of memory. Check with `docker inspect -f '{{.State.OOMKilled}}' kothai`. In Settings, switch the language model to **Off** for immediate relief, then pick smaller models or turn off image captioning.
</Accordion>

<Accordion title="First boot takes a very long time">
Expected. It's fetching 3+ GB for the default setup, less if you picked lighter models. Watch it with `docker compose logs -f`. The UI works throughout.
</Accordion>

<Accordion title="Permission denied writing to data">
The entrypoint repairs ownership at startup, but only when it starts as root. If you pass `--user`, make sure that user owns `./data` and `./models` on the host.
</Accordion>

<Accordion title="Port already in use">
Change the host side of the mapping in `docker-compose.yml`, e.g. `"8080:5173"`, or set `PORT`.
</Accordion>
</Accordions>
