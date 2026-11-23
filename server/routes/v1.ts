import type { ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { Info } from '@kothai/api'
import { PASSWORD } from '../config.ts'
import { json } from '../lib/http.ts'

// Not imported from @kothai/api: that is a runtime value, and the runtime image
// carries no packages/ source, so the import would crash the server on boot.
// test/server/routes/v1-info.test.ts pins this to the package's API_VERSION.
const API_VERSION = 1

// package.json ships in the runtime image; read once, not per request.
const SERVER_VERSION: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version

export function handleInfo(res: ServerResponse): void {
  const info: Info = {
    apiVersion: API_VERSION,
    minClientVersion: 1,
    serverVersion: SERVER_VERSION,
    signIn: PASSWORD ? ['password'] : ['none'],
    cloud: false,
  }
  json(res, 200, info)
}
