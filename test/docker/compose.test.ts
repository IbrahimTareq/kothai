// The Ollama tile falls back to http://host.docker.internal:11434/v1 for an
// Ollama on the host (server/ai/endpoints.ts). Docker Desktop resolves that
// name by itself; Linux resolves it only when the container maps it, and
// neither compose file did, so a host Ollama was unreachable from either.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')
// The block of one service: from its key to the next key at the same indent.
const service = (yml: string, name: string) =>
  yml.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  \\w|\\n\\w|$)`))?.[1] ?? ''
const MAPPED = /extra_hosts:\s*\[\s*"host\.docker\.internal:host-gateway"\s*\]/

test('docker-compose.yml maps host.docker.internal on the kothai service', () => {
  assert.match(service(read('docker-compose.yml'), 'kothai'), MAPPED)
})

// Kothai shares the sidecar's network namespace there, and Docker refuses
// extra_hosts beside network_mode: service:… — so the mapping lives on the
// sidecar, whose /etc/hosts the kothai container shares.
test('the tailscale compose file maps it on the service that owns the network', () => {
  assert.match(service(read('docker-compose.tailscale.yml'), 'tailscale'), MAPPED)
})
