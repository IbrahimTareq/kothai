// HTTP plumbing shared by the router and route handlers: JSON responses,
// request-body parsing, pasted-image persistence, and static file serving.
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { UPLOAD_DIR } from '../data/notes.js'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(LIB_DIR, '..', '..', 'dist') // built client at repo root

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

// ---- tiny helpers ------------------------------------------------------
export function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

// Same as json(), but with a Content-Disposition that makes the browser save
// it as a file instead of navigating to it.
export function downloadJson(res, filename, obj) {
  const body = JSON.stringify(obj, null, 2)
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  })
  res.end(body)
}

export function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// Persist a pasted (base64 data-URL) image to disk.
// Returns { webPath, absPath } or null.
export async function saveImage(dataUrl) {
  const m = /^data:(image\/(png|jpe?g|gif|webp));base64,(.+)$/i.exec(dataUrl || '')
  if (!m) return null
  const ext = m[2].toLowerCase().replace('jpeg', 'jpg')
  const name = `${randomUUID()}.${ext}`
  const absPath = path.join(UPLOAD_DIR, name)
  await writeFile(absPath, Buffer.from(m[3], 'base64'))
  return { webPath: `/uploads/${name}`, absPath }
}

// ---- static files ------------------------------------------------------

// A Vite content hash in the filename (index-CKKCRydn.js): the URL changes
// whenever the bytes do, which is what makes pinning it forever safe.
const HASHED_RE = /-[A-Za-z0-9_-]{8,}\.\w+$/

// Decided from the URL rather than the resolved file, so a request that falls
// through to the SPA shell is treated as the route it asked for, not as
// index.html.
export function cacheControlFor(urlPath) {
  // The user's own uploads. `meta-<noteId>.jpg` is a stable name that a
  // re-enrich overwrites in place, so these get a short freshness window and
  // then revalidate — a 304 is ~200 bytes against a ~190KB thumbnail — rather
  // than being pinned to a name that can go stale.
  if (urlPath.startsWith('/uploads/')) return 'private, max-age=3600, must-revalidate'
  if (HASHED_RE.test(urlPath)) return 'public, max-age=31536000, immutable'
  // index.html (directly or via the SPA fallback) and any other unhashed
  // asset: cacheable, but checked every time so a deploy lands immediately.
  return 'no-cache'
}

// Strong validator over the two things that change when a file is rewritten.
// Size alone would miss an in-place overwrite of identical length, so mtime
// is what actually carries the change.
export function etagFor(stat) {
  return `"${Math.floor(stat.mtimeMs).toString(16)}-${stat.size.toString(16)}"`
}

// Per RFC 9110 an If-None-Match, when present, wins outright and
// If-Modified-Since is not consulted at all.
function isFresh(req, etag, mtimeMs) {
  const inm = req.headers['if-none-match']
  if (inm) return inm.split(',').some((t) => t.trim() === etag)
  const ims = req.headers['if-modified-since']
  if (!ims) return false
  const since = Date.parse(ims)
  // Last-Modified only has second precision, so compare at that resolution.
  return Number.isFinite(since) && Math.floor(mtimeMs / 1000) <= Math.floor(since / 1000)
}

export async function serveStatic(req, res, urlPath) {
  // uploaded images live in ./data/uploads, everything else in ./dist (built client)
  let filePath
  if (urlPath.startsWith('/uploads/')) {
    filePath = path.join(UPLOAD_DIR, path.basename(urlPath))
  } else {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
    filePath = path.join(PUBLIC_DIR, rel)
    if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' })
    // SPA fallback: extension-less paths (/everything, /settings, …) are
    // client-side routes, so serve the app shell instead of 404ing.
    if (!existsSync(filePath) && !path.extname(rel)) filePath = path.join(PUBLIC_DIR, 'index.html')
  }
  if (!existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const stat = statSync(filePath)
  const etag = etagFor(stat)
  const validators = {
    'Cache-Control': cacheControlFor(urlPath),
    ETag: etag,
    'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
  }
  // The whole point of the gallery: on a revisit, hundreds of thumbnails
  // answer here instead of re-sending their bytes.
  if (isFresh(req, etag, stat.mtimeMs)) {
    res.writeHead(304, validators)
    res.end()
    return
  }

  const data = await readFile(filePath)
  res.writeHead(200, {
    ...validators,
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
  })
  res.end(data)
}
