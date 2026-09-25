// /api/backups — the backups server/backups.ts keeps in data/backups, as
// Settings shows them: the list, a download of any one, and the switch for
// the daily one. The download is how a copy leaves a PaaS volume, which has no
// other way out.
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DATA_DIR } from '../config.ts'
import * as settings from '../data/settings.ts'
import { listBackups } from '../backups.ts'
import { json, readBody } from '../lib/http.ts'

async function overview() {
  const { files, failure } = await listBackups()
  return { enabled: settings.backupsOn(), files, failure }
}

export async function handleListBackups(res: ServerResponse): Promise<void> {
  json(res, 200, await overview())
}

export async function handleSetBackups(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown
  try {
    body = await readBody(req, 1024)
  } catch {
    return json(res, 400, { error: 'Could not read the request.' })
  }
  const enabled = typeof body === 'object' && body !== null && 'enabled' in body ? body.enabled : undefined
  if (typeof enabled !== 'boolean') return json(res, 400, { error: 'Send { "enabled": true } or false.' })
  await settings.save({ backups: enabled })
  json(res, 200, await overview())
}

// `name` comes from the URL, so it is served only if the listing itself
// produced it — never joined onto a path first and checked after.
export async function handleDownloadBackup(res: ServerResponse, name: string): Promise<void> {
  const file = (await listBackups()).files.find(f => f.name === name)
  if (!file) return json(res, 404, { error: 'No backup by that name.' })
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Length': file.size,
    'Content-Disposition': `attachment; filename="${file.name}"`,
    'Cache-Control': 'no-store',
  })
  await pipeline(createReadStream(path.join(DATA_DIR, 'backups', file.name)), res)
}
