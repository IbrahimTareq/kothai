// The process-wide remote provider, booted from env: each role reaches the
// endpoint config resolved for it, and a model named by env beats the one
// saved in settings.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listenOnLoopback, record } from '../../../helpers/http.ts'

const seen: { at: string; url: string; body: unknown }[] = []
const serve = async (at: string) => {
  const s = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      seen.push({ at, url: req.url || '', body: raw ? JSON.parse(raw) : null })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ embedding: [1] }] }))
    })
  })
  after(() => s.close())
  return `http://127.0.0.1:${await listenOnLoopback(s)}`
}

process.env.KOTHAI_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'kothai-remote-singleton-'))
process.env.KOTHAI_AI_BASE_URL = await serve('shared')
process.env.KOTHAI_AI_EMBED_BASE_URL = await serve('embed')
process.env.KOTHAI_AI_EMBED_MODEL = 'env-embed'
const { remoteProvider } = await import('../../../../server/ai/providers/remote-singleton.ts')

test('boot sends embed to its own endpoint with the env model', async () => {
  await remoteProvider.init({ remote: { llm: 'm', embed: 'settings-embed', vision: '' } })
  seen.length = 0
  await remoteProvider.embedText('x')
  assert.deepEqual(
    seen.map(r => [r.at, r.url]),
    [['embed', '/embeddings']],
  )
  assert.equal(record(seen[0].body).model, 'env-embed')
})
