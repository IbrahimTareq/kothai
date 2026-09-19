import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import http from 'node:http'
import { json, serveStatic } from './lib/http.ts'
import { PASSWORD } from './config.ts'
import { authGate } from './routes/auth.ts'
import {
  handleSave,
  handleNotes,
  handleNotesDelta,
  handleGetNote,
  handleNoteSlides,
  handleUpdateNote,
  handleDeleteNote,
  handleRetagNote,
} from './routes/notes.ts'
import { handleImport } from './routes/import.ts'
import { handleAvailabilityScan, handleAvailabilityRemove } from './routes/availability.ts'
import { handleExport } from './routes/export.ts'
import { handleBackup } from './routes/backup.ts'
import { handleCheckpoint } from './routes/checkpoint.ts'
import { handleWipe } from './routes/wipe.ts'
import { handleModelFiles, handleDeleteModelFile } from './routes/models.ts'
import { handleAsk } from './routes/ask.ts'
import { handleChats, handleChat, handleRenameChat, handleDeleteChat } from './routes/chats.ts'
import {
  handleCollections,
  handleCreateCollection,
  handleUpdateCollection,
  handleAddItem,
  handleRemoveItem,
  handleDeleteCollection,
} from './routes/collections.ts'
import {
  handleStatus,
  handleGetSettings,
  handleSaveSettings,
  handleSetup,
  handleSetupEndpoint,
  handleSaveEndpoint,
  handleClearEndpoint,
  handleBacklog,
  handleEnrichBacklog,
  handlePrioritize,
  handleRetagAll,
} from './routes/settings.ts'
import { handleSetupTest } from './routes/setup-test.ts'

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`)
  const p = url.pathname
  try {
    // Liveness, and the ONLY thing in front of the password gate. The container
    // healthcheck carries no credentials, so a 401 here would have every
    // orchestrator mark the container unhealthy and restart-loop it forever.
    // Deliberately says nothing about the install; /api/status, which reports
    // model config and note counts, stays behind the gate.
    if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true })
    // Guards every route below AND the static/uploads fallthrough, which is why
    // it lives here rather than being repeated per handler. No-op when
    // KOTHAI_PASSWORD is unset.
    if (PASSWORD && (await authGate(req, res, p, { password: PASSWORD }))) return

    if (req.method === 'POST' && p === '/api/save') return await handleSave(req, res)
    if (req.method === 'POST' && p === '/api/ask') return await handleAsk(req, res)
    if (req.method === 'GET' && p === '/api/notes/delta') return handleNotesDelta(res, url)
    if (req.method === 'GET' && p === '/api/notes') return handleNotes(res, url)
    if (req.method === 'GET' && /^\/api\/notes\/[^/]+$/.test(p))
      return handleGetNote(res, decodeURIComponent(p.slice(11)))
    if (req.method === 'GET' && p === '/api/chats') return handleChats(res, url.searchParams)
    if (req.method === 'GET' && p.startsWith('/api/chats/')) return handleChat(res, p.split('/').pop() ?? '')
    if (req.method === 'PATCH' && p.startsWith('/api/chats/'))
      return await handleRenameChat(req, res, p.split('/').pop() ?? '')
    if (req.method === 'DELETE' && p.startsWith('/api/chats/'))
      return await handleDeleteChat(res, p.split('/').pop() ?? '')
    if (req.method === 'GET' && p === '/api/status') return handleStatus(res)
    if (req.method === 'GET' && p === '/api/settings') return await handleGetSettings(res)
    if (req.method === 'POST' && p === '/api/settings') return await handleSaveSettings(req, res)
    if (req.method === 'POST' && p === '/api/setup') return await handleSetup(req, res)
    if (req.method === 'POST' && p === '/api/setup/test') return await handleSetupTest(req, res)
    if (req.method === 'POST' && p === '/api/setup/endpoint') return await handleSetupEndpoint(req, res)
    if (req.method === 'POST' && p === '/api/settings/endpoint') return await handleSaveEndpoint(req, res)
    if (req.method === 'DELETE' && p === '/api/settings/endpoint') return await handleClearEndpoint(req, res)
    if (req.method === 'POST' && p === '/api/import') return await handleImport(req, res)
    if (req.method === 'GET' && p === '/api/export') return handleExport(res)
    if (req.method === 'GET' && p === '/api/backup') return await handleBackup(req, res)
    if (req.method === 'POST' && p === '/api/checkpoint') return await handleCheckpoint(res)
    if (req.method === 'POST' && p === '/api/wipe') return await handleWipe(req, res)
    if (req.method === 'GET' && p === '/api/models/files') return await handleModelFiles(res)
    // The parameter is a cache FILENAME, so it arrives percent-encoded and is
    // decoded here; routes/models.js re-validates it before any path is built
    // from it. Anchored so only a direct child name can match — a nested path
    // falls through to the 405 below rather than reaching the handler.
    if (req.method === 'DELETE' && /^\/api\/models\/files\/[^/]+$/.test(p)) {
      return await handleDeleteModelFile(res, decodeURIComponent(p.slice('/api/models/files/'.length)))
    }
    if (req.method === 'POST' && p === '/api/availability/scan') return await handleAvailabilityScan(req, res)
    if (req.method === 'POST' && p === '/api/availability/remove') return await handleAvailabilityRemove(req, res)
    if (req.method === 'GET' && p === '/api/enrich/backlog') return handleBacklog(res)
    if (req.method === 'POST' && p === '/api/enrich/backlog') return handleEnrichBacklog(res)
    if (req.method === 'POST' && p === '/api/enrich/prioritize') return await handlePrioritize(req, res)
    if (p === '/api/collections') {
      if (req.method === 'GET') return handleCollections(res)
      if (req.method === 'POST') return await handleCreateCollection(req, res)
    }
    if (p.startsWith('/api/collections/')) {
      const seg = p.split('/').filter(Boolean)
      const id = seg[2]
      if (seg[3] === 'items') {
        if (req.method === 'POST' && seg.length === 4) return await handleAddItem(req, res, id)
        if (req.method === 'DELETE' && seg.length === 5) return await handleRemoveItem(res, id, seg[4])
      } else if (seg.length === 3) {
        if (req.method === 'PATCH') return await handleUpdateCollection(req, res, id)
        if (req.method === 'DELETE') return await handleDeleteCollection(res, id)
      }
    }
    if (req.method === 'POST' && p === '/api/enrich/retag-all') return await handleRetagAll(res)
    if (req.method === 'POST' && /^\/api\/notes\/[^/]+\/retag$/.test(p)) {
      return await handleRetagNote(res, p.split('/')[3])
    }
    if (req.method === 'POST' && /^\/api\/notes\/[^/]+\/slides$/.test(p)) {
      return await handleNoteSlides(res, decodeURIComponent(p.split('/')[3]))
    }
    if (req.method === 'PATCH' && p.startsWith('/api/notes/'))
      return await handleUpdateNote(req, res, p.split('/').pop() ?? '')
    if (req.method === 'DELETE' && p.startsWith('/api/notes/'))
      return await handleDeleteNote(res, p.split('/').pop() ?? '')
    if (req.method === 'GET') return await serveStatic(req, res, p)
    json(res, 405, { error: 'method not allowed' })
  } catch (err) {
    console.error('[server] error:', err)
    json(res, 500, { error: (err instanceof Error && err.message) || 'internal error' })
  }
}

export function createServer(): Server {
  return http.createServer(handleRequest)
}
