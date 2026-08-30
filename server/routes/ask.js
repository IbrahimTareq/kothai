import * as ai from '../ai/index.js'
import * as store from '../data/notes.js'
import * as chats from '../data/chats.js'
import * as settings from '../data/settings.js'
import * as prompts from '../ai/prompts.js'
import { json, readBody, saveImage } from '../lib/http.js'

// Server-sent events, opened only once the request has cleared every gate —
// before that a plain JSON error is still the right answer, and the headers
// haven't been written yet.
function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // tell a reverse proxy not to buffer the stream
  })
  return {
    // JSON.stringify escapes newlines, so a payload can never break the frame.
    send(event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) },
    end() { res.end() },
  }
}

export async function handleAsk(req, res) {
  const body = await readBody(req)
  const wantsStream = /text\/event-stream/.test(req.headers.accept || '')
  const question = (body.question || '').toString().trim()
  const imageData = body.image
  const chatId = body.chatId || null
  if (!question && !imageData) return json(res, 400, { error: 'Ask a question.' })

  const residency = settings.getResidency()
  // Feature gates: structured codes so the client can render a disabled state.
  if (imageData && residency.vision === 'off') {
    return json(res, 409, { error: 'Image questions need the vision model — enable it in Settings.', code: 'vision_off' })
  }
  if (!imageData && residency.llm === 'off') {
    return json(res, 409, { error: 'Ask needs the language model — enable it in Settings.', code: 'llm_off' })
  }
  // A download already in flight (first boot / model switch) can take minutes —
  // don't hold the request open for that. A local on-demand load is seconds and
  // is awaited below via acquire(). Vision only matters for image questions —
  // acquire() would otherwise just block on its in-flight download instead of
  // failing fast, same as llm/embed would without this check.
  const snap = ai.statusSnapshot()
  if (
    snap.roles.llm.state === 'loading' ||
    (residency.embed !== 'off' && snap.roles.embed.state === 'loading') ||
    (imageData && snap.roles.vision.state === 'loading')
  ) {
    return json(res, 503, { error: 'Models are still loading — try again in a moment.' })
  }

  // Stopping the answer stops the model: the client aborts its fetch, which
  // closes the request, which cancels the run. An abandoned exchange is
  // deliberately not recorded — a stopped question shouldn't reappear in the
  // history as though it had been answered.
  const ctl = new AbortController()
  // Listen on the RESPONSE, not the request. readBody() has already drained the
  // request stream by this point, and Node emits 'close' on an IncomingMessage
  // once the message is complete — so a listener attached here never fires, and
  // a stopped answer went on generating and recording itself. The response's
  // 'close' is the one that means "the client is gone"; writableEnded keeps a
  // normal finish from being read as a disconnect. req is kept as a belt-and-
  // braces second signal, harmless under the same guard.
  const onGone = () => { if (!res.writableEnded) ctl.abort() }
  res.on('close', onGone)
  req.on('close', onGone)

  let out = null   // set once the stream is open; until then errors are JSON

  // Persist the exchange so chats survive reloads and can be browsed/resumed.
  const record = async (answer, sources, image = null) => {
    if (ctl.signal.aborted) return out ? out.end() : undefined
    const chat = await chats.appendExchange(
      chatId,
      { role: 'user', text: question, image },
      { role: 'ai', text: answer, sources }
    )
    if (out) { out.send('done', { chatId: chat.id }); out.end() }
    else json(res, 200, { answer, sources, chatId: chat.id })
  }

  // Once the stream is open a failure has to travel down it — the status line
  // has already gone out as 200.
  const fail = (code, payload) => {
    if (out) { out.send('error', payload); out.end() }
    else json(res, code, payload)
  }

  // Image attached to the question → answer about it directly with the vision model.
  if (imageData) {
    const img = await saveImage(imageData)
    if (!img) return json(res, 400, { error: 'Could not read the attached image.' })
    try {
      const answer = await ai.describeImage({
        absPath: img.absPath,
        prompt: question || 'What is in this image? Describe it in detail.',
      })
      return await record(answer, [], img.webPath)
    } catch (e) {
      if (e instanceof ai.FeatureDisabledError) return fail(409, { error: e.message, code: e.code })
      return fail(500, { error: 'Vision model error: ' + e.message })
    }
  }

  if (store.count() === 0) {
    return await record("You haven't saved anything yet. Paste a link, note, or image first!", [])
  }

  try {
    // The chat this question belongs to, so a follow-up ("what else did they
    // make?") can be both retrieved and answered in context. Read BEFORE the
    // exchange is recorded, so it holds the previous turns and not this one.
    const history = chats.recentMessages(chatId)
    // Retrieval gets the previous user turn prepended: a follow-up has no
    // subject in it, so on its own it embeds to nothing useful and retrieval
    // would answer a different question than the model is then asked.
    const queryText = prompts.retrievalQuery(question, history)

    // Hybrid retrieval: cosine and keyword results fused by reciprocal rank
    // (see notes.js). They miss in opposite directions — cosine loses rare
    // literal tokens, keyword loses every paraphrase — so one strong signal
    // is enough for a note to surface. With the embed role off there is no
    // query embedding and the fusion degrades to keyword-only.
    const sources = residency.embed !== 'off'
      // A question is embedded as a query, not as a document — see
      // prompts.js's embedInput. The two are different kinds of text and a
      // prompt-instructed model encodes them differently.
      ? store.hybridSearch(await ai.embedText(queryText, { mode: 'query' }), queryText)
      : store.textSearch(queryText)
    // The cards can render while the prose is still arriving, so the sources
    // go out as soon as retrieval has them rather than with the answer.
    if (wantsStream) { out = openStream(res); out.send('sources', { sources }) }
    const answer = await ai.answerStream({
      question, contextNotes: sources, history,
      onToken: out ? (text) => out.send('delta', { text }) : undefined,
      signal: ctl.signal,
    })
    await record(answer, sources)
  } catch (e) {
    if (e instanceof ai.FeatureDisabledError) return fail(409, { error: e.message, code: e.code })
    if (ctl.signal.aborted) return out ? out.end() : undefined
    if (out) return fail(500, { error: e.message })
    throw e
  }
}
