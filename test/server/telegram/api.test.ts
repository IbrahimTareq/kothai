// The Bot API surface Kothai uses. fetch is injected rather than globally
// stubbed so these tests assert the exact URLs — the offset and timeout params
// are what make long polling correct, and a silent typo in either would show
// up only as "captures sometimes arrive twice".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getUpdates, fetchPhotoDataUrl } from '../../../server/telegram/api.ts'

const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response

test('getUpdates: sends the offset and a long-poll timeout', async () => {
  const seen: string[] = []
  const res = await getUpdates('TOKEN', 7, {
    fetchImpl: (async (url: string) => {
      seen.push(url)
      return jsonRes({ ok: true, result: [{ update_id: 7 }] })
    }) as unknown as typeof fetch,
  })
  assert.match(seen[0], /^https:\/\/api\.telegram\.org\/botTOKEN\/getUpdates\?/)
  assert.match(seen[0], /offset=7/)
  assert.match(seen[0], /timeout=30/)
  assert.deepEqual(res, { ok: true, updates: [{ update_id: 7 }] })
})

test('getUpdates: a 409 is reported as a conflict, not a generic failure', async () => {
  const res = await getUpdates('TOKEN', 0, {
    fetchImpl: (async () => jsonRes({}, 409)) as unknown as typeof fetch,
  })
  assert.deepEqual(res, { ok: false, conflict: true })
})

test('getUpdates: any other error is a plain failure the caller should back off from', async () => {
  const res = await getUpdates('TOKEN', 0, {
    fetchImpl: (async () => jsonRes({}, 500)) as unknown as typeof fetch,
  })
  assert.deepEqual(res, { ok: false, conflict: false })
})

test('fetchPhotoDataUrl: resolves the file path then returns a data URL saveImage accepts', async () => {
  const dataUrl = await fetchPhotoDataUrl('TOKEN', 'FILE', {
    fetchImpl: (async (url: string) => {
      if (url.includes('getFile')) return jsonRes({ ok: true, result: { file_path: 'photos/a.jpg' } })
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as Response
    }) as unknown as typeof fetch,
  })
  assert.match(dataUrl ?? '', /^data:image\/jpeg;base64,/)
})

test('fetchPhotoDataUrl: a file with no path yields null rather than a broken note', async () => {
  const dataUrl = await fetchPhotoDataUrl('TOKEN', 'FILE', {
    fetchImpl: (async () => jsonRes({ ok: true, result: {} })) as unknown as typeof fetch,
  })
  assert.equal(dataUrl, null)
})
