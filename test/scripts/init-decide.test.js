// Unit tests for scripts/lib/init-decide.mjs — the pure logic turning probe
// facts and user answers into an image tag, an env map and warnings. No I/O,
// no Docker; every input is a plain object shaped like a real probe result.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GB, capability, chooseImage, buildEnv, decide } from '../../scripts/lib/init-decide.mjs'

const probe = (over = {}) => ({
  arch: 'arm64', avx2: null, memBytes: 8 * GB, diskBytes: 40 * GB,
  dockerOk: true, composeV2: true, existingDb: false, existingCompose: false, portFree: true,
  ...over,
})

test('arm64 with room can run models locally', () => {
  assert.deepEqual(capability(probe()), { canRunLocal: true, reason: null })
})

test('x86_64 without AVX2 cannot — the Celeron NAS case', () => {
  const r = capability(probe({ arch: 'x86_64', avx2: false }))
  assert.equal(r.canRunLocal, false)
  assert.match(r.reason, /AVX2/)
})

test('x86_64 with AVX2 can', () => {
  assert.equal(capability(probe({ arch: 'x86_64', avx2: true })).canRunLocal, true)
})

test('too little memory available to Docker cannot, and the reason names the figure', () => {
  const r = capability(probe({ memBytes: 1.5 * GB }))
  assert.equal(r.canRunLocal, false)
  assert.match(r.reason, /1\.5 GB/)
})

const answers = (over = {}) => ({ ai: 'local', baseUrl: null, apiKey: null, password: null, port: 5173, ...over })

test('a capable machine gets the full image', () => {
  assert.equal(chooseImage(probe(), answers()), 'latest')
})

// Verified 2026-09-02 against ghcr.io/ibrahimtareq/kothai:latest: ran the real
// image with STASH_AI_PROVIDER=remote, curled /api/health (`{"ok":true}`), and
// grepped the logs for "Bare worker started" — count was 0, so @qvac/sdk (and
// its native prebuilds) is never imported in remote mode. The rule holds.
test('a capable machine choosing an external endpoint still gets the full image, so local costs nothing later', () => {
  assert.equal(chooseImage(probe(), answers({ ai: 'external' })), 'latest')
})

test('an incapable machine gets lite', () => {
  assert.equal(chooseImage(probe({ arch: 'x86_64', avx2: false }), answers({ ai: 'external' })), 'lite')
})

test('disk is checked before capability — a capable machine with no room still gets lite', () => {
  assert.equal(chooseImage(probe({ diskBytes: 4 * GB }), answers()), 'lite')
})

test('--lite forces lite', () => {
  assert.equal(chooseImage(probe(), answers(), { lite: true }), 'lite')
})

test('local inference on the full image writes only the provider', () => {
  assert.deepEqual(buildEnv(answers({ ai: 'local' }), 'latest'), { STASH_AI_PROVIDER: 'local' })
})

test('an external endpoint writes the base url', () => {
  const env = buildEnv(answers({ ai: 'external', baseUrl: 'http://ollama:11434/v1' }), 'latest')
  assert.equal(env.STASH_AI_PROVIDER, 'remote')
  assert.equal(env.STASH_AI_BASE_URL, 'http://ollama:11434/v1')
})

test('an api key is written when given and the key is absent when not', () => {
  const withKey = buildEnv(answers({ ai: 'external', baseUrl: 'https://x/v1', apiKey: 'sk-abc' }), 'latest')
  assert.equal(withKey.STASH_AI_API_KEY, 'sk-abc')
  const without = buildEnv(answers({ ai: 'external', baseUrl: 'https://x/v1' }), 'latest')
  assert.equal('STASH_AI_API_KEY' in without, false)
})

test('the lite image is always remote — it cannot run models at all', () => {
  assert.equal(buildEnv(answers({ ai: 'none' }), 'lite').STASH_AI_PROVIDER, 'remote')
})

test('no AI on the full image stays local, so models can be switched on later in the web app', () => {
  assert.deepEqual(buildEnv(answers({ ai: 'none' }), 'latest'), { STASH_AI_PROVIDER: 'local' })
})

test('a password is written when set and omitted when null', () => {
  assert.equal(buildEnv(answers({ password: 'hunter2hunter2' }), 'latest').STASH_PASSWORD, 'hunter2hunter2')
  assert.equal('STASH_PASSWORD' in buildEnv(answers(), 'latest'), false)
})

test('a fresh machine scaffolds a compose file', () => {
  const d = decide(probe(), answers(), {})
  assert.equal(d.mode, 'scaffold')
  assert.equal(d.writeCompose, true)
  assert.equal(d.image, 'latest')
})

test('an existing database switches to update mode and never scaffolds', () => {
  const d = decide(probe({ existingDb: true, existingCompose: true }), answers(), {})
  assert.equal(d.mode, 'update')
  assert.equal(d.writeCompose, false)
})

test('an existing compose file is left alone even on a fresh install, and says so', () => {
  const d = decide(probe({ existingCompose: true }), answers(), {})
  assert.equal(d.writeCompose, false)
  assert.match(d.warnings.join(' '), /docker-compose\.yml already exists/)
})

test('low but workable memory warns without blocking', () => {
  const d = decide(probe({ memBytes: 3 * GB }), answers(), {})
  assert.equal(d.image, 'latest')
  assert.match(d.warnings.join(' '), /3 GB/)
})

test('an incapable machine asked for local inference is redirected to remote, with the reason', () => {
  const d = decide(probe({ arch: 'x86_64', avx2: false }), answers({ ai: 'local' }), {})
  assert.equal(d.env.STASH_AI_PROVIDER, 'remote')
  assert.match(d.warnings.join(' '), /AVX2/)
})

test('low memory does not warn about slowness when disk already forced lite', () => {
  const d = decide(probe({ memBytes: 3 * GB, diskBytes: 2 * GB }), answers(), {})
  assert.equal(d.image, 'lite')
  assert.equal(d.warnings.some((w) => w.includes('may be slow')), false)
})
