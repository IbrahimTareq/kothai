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
import { getMe, getUpdates, sendMessage } from '../../../server/telegram/api.ts'

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

test('getUpdates: passes the abort signal through, so a reconnect can end the long poll in flight', async t => {
  let seen: AbortSignal | null | undefined
  t.after(
    stubFetch((_url, init) => {
      seen = init?.signal
      return jsonRes({ ok: true, result: [] })
    }),
  )
  const controller = new AbortController()
  await getUpdates('TOKEN', 0, 30, controller.signal)
  assert.equal(seen, controller.signal)
})

test('getMe: a valid token answers with the bot username', async t => {
  let seenUrl = ''
  t.after(
    stubFetch(url => {
      seenUrl = url
      return jsonRes({ ok: true, result: { id: 1, is_bot: true, username: 'kothai_bot' } })
    }),
  )
  assert.deepEqual(await getMe('TOKEN'), { ok: true, username: 'kothai_bot' })
  assert.equal(seenUrl, 'https://api.telegram.org/botTOKEN/getMe')
})

test('getMe: a token Telegram rejects is an error the person pasting it can read', async t => {
  t.after(stubFetch(() => jsonRes({ ok: false, error_code: 401, description: 'Unauthorized' }, 401)))
  assert.deepEqual(await getMe('TOKEN'), { ok: false, error: 'Telegram did not recognise that token.' })
})

test('getMe: an unreachable Telegram is an error, not a throw', async t => {
  t.after(stubFetch(() => Promise.reject(new Error('network down'))))
  const res = await getMe('TOKEN')
  assert.equal(res.ok, false)
})
