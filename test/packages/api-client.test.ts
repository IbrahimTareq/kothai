import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiRequestError, createClient } from '@kothai/api'

interface Call {
  url: string
  init?: RequestInit
}

function fake(status: number, body: unknown) {
  const calls: Call[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

test('each method hits the right path and query', async () => {
  const { calls, fetch } = fake(200, {})
  const api = createClient({ baseUrl: 'http://h:1/', fetch })
  await api.info()
  await api.notes()
  await api.notes({ cursor: 'c', limit: 5, space: 's 1' })
  await api.spaces()
  await api.changes()
  await api.changes('abc')
  await api.save({ url: 'https://x.test', note: 'hi' })
  assert.deepEqual(
    calls.map(c => `${c.init?.method ?? 'GET'} ${c.url}`),
    [
      'GET http://h:1/api/v1/info',
      'GET http://h:1/api/v1/notes',
      'GET http://h:1/api/v1/notes?cursor=c&limit=5&space=s+1',
      'GET http://h:1/api/v1/spaces',
      'GET http://h:1/api/v1/changes',
      'GET http://h:1/api/v1/changes?since=abc',
      'POST http://h:1/api/v1/save',
    ],
  )
  assert.equal(calls[6].init?.body, JSON.stringify({ url: 'https://x.test', note: 'hi' }))
})

test('the bearer header is sent only when a token is given', async () => {
  const a = fake(200, {})
  await createClient({ baseUrl: 'http://h', fetch: a.fetch }).spaces()
  assert.equal(new Headers(a.calls[0].init?.headers).has('authorization'), false)
  const b = fake(200, {})
  await createClient({ baseUrl: 'http://h', token: 't0k', fetch: b.fetch }).spaces()
  assert.equal(new Headers(b.calls[0].init?.headers).get('authorization'), 'Bearer t0k')
})

test('a non-2xx answer throws ApiRequestError with status and code', async () => {
  const { fetch } = fake(401, { error: 'sign in', code: 'auth_required' })
  const err = await createClient({ baseUrl: 'http://h', fetch })
    .spaces()
    .catch(e => e)
  assert.ok(err instanceof ApiRequestError)
  assert.equal(err.status, 401)
  assert.equal(err.code, 'auth_required')
  assert.equal(err.message, 'sign in')
})

test('a body that is not JSON throws with code network', async () => {
  const { fetch } = fake(502, '<html>bad gateway</html>')
  const err = await createClient({ baseUrl: 'http://h', fetch })
    .info()
    .catch(e => e)
  assert.ok(err instanceof ApiRequestError)
  assert.equal(err.status, 502)
  assert.equal(err.code, 'network')
})

test('a fetch that rejects throws with code network', async () => {
  const fetch = (async () => {
    throw new TypeError('offline')
  }) as typeof globalThis.fetch
  const err = await createClient({ baseUrl: 'http://h', fetch })
    .info()
    .catch(e => e)
  assert.ok(err instanceof ApiRequestError)
  assert.equal(err.code, 'network')
})

test('an error body without a code keeps the status and reports code network', async () => {
  const { fetch } = fake(500, { error: 'invalid JSON body' })
  const err = await createClient({ baseUrl: 'http://h', fetch })
    .save({ url: 'x' })
    .catch(e => e)
  assert.ok(err instanceof ApiRequestError)
  assert.equal(err.status, 500)
  assert.equal(err.code, 'network')
  assert.equal(err.message, 'invalid JSON body')
})
