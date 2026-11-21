# Troubleshooting

## Health

The container ships a healthcheck:

```bash
docker inspect -f '{{.State.Health.Status}}' kothai
```

It reports **liveness, not model readiness**. The container is `healthy` as soon as the HTTP server answers, whether or not an AI endpoint is reachable. For AI state, use the API:

```bash
curl -s localhost:5173/api/status
```

## Common issues

<Accordions>
<Accordion title="Ollama unreachable from Docker">
`localhost` inside the Kothai container is the container itself, not your machine. Use the address that matches where Ollama runs:

- Started with `docker compose --profile ollama`: `http://ollama:11434/v1`, the compose service name.
- Running on the host: `http://host.docker.internal:11434/v1`. On Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the service. Ollama must also listen beyond loopback (`OLLAMA_HOST=0.0.0.0`).
- Running Kothai without Docker: `http://localhost:11434/v1`.
</Accordion>

<Accordion title="Search is keyword-only">
No embedding endpoint is working. Claude can't embed, so with Claude for chat, add an embeddings provider. After an upgrade from on-device models, connect one in Settings and Kothai re-embeds your library once.
</Accordion>

<Accordion title="Permission denied writing to data">
The entrypoint repairs ownership at startup, but only when it starts as root. If you pass `--user`, make sure that user owns `./data` on the host.
</Accordion>

<Accordion title="Port already in use">
Change the host side of the mapping in `docker-compose.yml`, e.g. `"8080:5173"`. Don't set `PORT` for this: it moves the port inside the container and the mapping stops reaching it.
</Accordion>
</Accordions>
