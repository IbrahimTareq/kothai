// The Bot API surface Kothai uses. api.ts calls global fetch directly — there
// is no lower seam like lib/ssrf.ts's safeFetch for it to inject around,
// because every URL here is hard-coded to api.telegram.org rather than
// attacker-influenced — so these stub globalThis.fetch and restore it after,
// the same pattern test/server/ai/article-extract.test.ts uses for meta.ts's
// get(). The offset and timeout params on getUpdates are what make long
// polling correct, and a silent typo in either would show up only as
// "captures sometimes arrive twice".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getUpdates, sendMessage, fetchPhotoDataUrl } from '../../../server/telegram/api.ts'

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => handler(url, init)) as unknown as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

test('getUpdates: sends the offset and a long-poll timeout', async t => {
  const seen: string[] = []
  t.after(
    stubFetch(url => {
      seen.push(url)
      return jsonRes({ ok: true, result: [{ update_id: 7 }] })
    }),
  )
  const res = await getUpdates('TOKEN', 7)
  assert.match(seen[0], /^https:\/\/api\.telegram\.org\/botTOKEN\/getUpdates\?/)
  assert.match(seen[0], /offset=7/)
  assert.match(seen[0], /timeout=30/)
  assert.deepEqual(res, { ok: true, updates: [{ update_id: 7 }] })
})

test('getUpdates: a 409 is reported as a conflict, not a generic failure', async t => {
  t.after(stubFetch(() => jsonRes({}, 409)))
  const res = await getUpdates('TOKEN', 0)
  assert.deepEqual(res, { ok: false, conflict: true })
})

test('getUpdates: any other error is a plain failure the caller should back off from', async t => {
  t.after(stubFetch(() => jsonRes({}, 500)))
  const res = await getUpdates('TOKEN', 0)
  assert.deepEqual(res, { ok: false, conflict: false })
})

test('sendMessage: POSTs the chat id and text', async t => {
  let seenUrl = ''
  let seenBody: unknown
  t.after(
    stubFetch((url, init) => {
      seenUrl = url
      seenBody = JSON.parse(String(init?.body))
      return jsonRes({ ok: true })
    }),
  )
  await sendMessage('TOKEN', 42, 'saved')
  assert.equal(seenUrl, 'https://api.telegram.org/botTOKEN/sendMessage')
  assert.deepEqual(seenBody, { chat_id: 42, text: 'saved' })
})

// The riskiest line in the file: sendMessage runs after a capture already
// saved, so a network blip here must never surface as a thrown error.
test('sendMessage: a rejected fetch does not throw', async t => {
  t.after(stubFetch(() => Promise.reject(new Error('network down'))))
  await assert.doesNotReject(sendMessage('TOKEN', 42, 'saved'))
})

test('fetchPhotoDataUrl: resolves the file path then returns a data URL saveImage accepts', async t => {
  t.after(
    stubFetch(url => {
      if (url.includes('getFile')) return jsonRes({ ok: true, result: { file_path: 'photos/a.jpg' } })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }),
  )
  const dataUrl = await fetchPhotoDataUrl('TOKEN', 'FILE')
  assert.match(dataUrl ?? '', /^data:image\/jpeg;base64,/)
})

test('fetchPhotoDataUrl: a file with no path yields null rather than a broken note', async t => {
  t.after(stubFetch(() => jsonRes({ ok: true, result: {} })))
  const dataUrl = await fetchPhotoDataUrl('TOKEN', 'FILE')
  assert.equal(dataUrl, null)
})

// Telegram's file_path download URLs expire, and Task 5's poll loop does not
// advance its offset when handling an update throws — so a throw here would
// have Telegram redeliver the same update, and the same throw, forever.
test('fetchPhotoDataUrl: a network failure resolving the file path yields null instead of throwing', async t => {
  t.after(stubFetch(() => Promise.reject(new Error('DNS lookup failed'))))
  const dataUrl = await fetchPhotoDataUrl('TOKEN', 'FILE')
  assert.equal(dataUrl, null)
})

test('fetchPhotoDataUrl: a network failure downloading the file yields null instead of throwing', async t => {
  t.after(
    stubFetch(url => {
      if (url.includes('getFile')) return jsonRes({ ok: true, result: { file_path: 'photos/a.jpg' } })
      return Promise.reject(new Error('file_path expired'))
    }),
  )
  const dataUrl = await fetchPhotoDataUrl('TOKEN', 'FILE')
  assert.equal(dataUrl, null)
})
