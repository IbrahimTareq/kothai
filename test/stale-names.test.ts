import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

// The STASH_ → KOTHAI_ env rename (e55fe82) missed a line of Settings copy,
// which went on telling users that STASH_AI_BASE_URL overrides their endpoint
// long after the server stopped reading it. Nothing else would ever notice.
const root = new URL('..', import.meta.url).pathname
const dirs = ['client', 'server', 'docs', 'docker', 'site/public']
const top = ['README.md', 'Dockerfile', 'docker-compose.yml', 'docker-compose.tailscale.yml']

test('no source or doc names a STASH_ env var', () => {
  const files = [
    ...top,
    ...dirs.flatMap(d =>
      readdirSync(join(root, d), { recursive: true, encoding: 'utf8' })
        .map(f => join(d, f))
        .filter(f => !f.includes('superpowers') && statSync(join(root, f)).isFile()),
    ),
  ]
  const hits = files.filter(f => /STASH_[A-Z]/.test(readFileSync(join(root, f), 'utf8')))
  assert.deepEqual(hits, [])
})
