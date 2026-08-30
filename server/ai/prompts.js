// Prompt text and response schema shared by every inference provider.
//
// Pure: no SDK, no HTTP. Both providers build their requests from these
// builders so a note classified on-device and one classified against a
// remote endpoint are asked exactly the same question. Inlining prompts in
// a provider would guarantee drift the first time one gets tuned.
import { normalizeTags } from '../lib/tags.js'

export const NOTE_TYPES = ['link', 'image', 'video', 'code', 'text']

export const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: NOTE_TYPES },
    category: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['type', 'category', 'title', 'summary', 'tags'],
}

export const DESCRIBE_IMAGE_PROMPT =
  'Describe this image in 2-3 sentences for search: visible text, people, objects, UI elements, overall context.'

// The cover frame of a saved video (any platform — a reel, a TikTok, a
// YouTube thumbnail, an og:image). Transcription comes FIRST and is asked for
// explicitly, because short-form covers are built around burned-in hook text
// ("3 ingredients", "DON'T do this in Tokyo") that is usually the single best
// retrieval key the video has, and a model asked only to "describe" will
// paraphrase it away. Chrome is named generically rather than per-platform:
// this used to run only on Instagram thumbnails and now runs on any note that
// has one.
export const DESCRIBE_THUMB_PROMPT = [
  'This is the cover frame of a saved video or link.',
  'First, transcribe any text visible on the image exactly as written — overlay captions, titles, on-screen labels, signs, packaging.',
  'Then describe the frame in 1-2 sentences for search: setting, people, objects, activity.',
  'Ignore player and app chrome: play buttons, usernames, follow buttons, view/like/comment counts, progress bars, watermarks.',
].join(' ')

export function classifySystemPrompt({ now, knownTags = [], candidateTags = [] }) {
  const vocab = normalizeTags(knownTags, { max: 60 })
  const candidates = normalizeTags(candidateTags, { max: 30 })
  return [
    'You organise items a user saves to a personal knowledge base.',
    'Classify the item and return JSON only.',
    `Choose "type" from: ${NOTE_TYPES.join(', ')}.`,
    '- link: a web URL/bookmark. video: a link to a video (YouTube, Vimeo, etc).',
    '- code: a code snippet.',
    '- image: an attached picture. text: a general note that fits none of the above.',
    '"category" is a short topical label (1-2 words, Title Case) like "Tech", "Recipes", "Work", "Finance", "Health".',
    '"title" is a concise human title (max ~8 words).',
    '"summary" is one sentence describing the item for later search.',
    '"tags" is 6-10 lowercase keywords — never fewer than 6 — naming the SPECIFIC subject — products, brands, places, people, materials, topics, activities, settings. Favour concrete nouns over vague ones; if you are short of specific nouns, add a second-order concept (mood, occasion, genre) rather than stopping early.',
    'Never use platform names (instagram, tiktok, youtube, reel), engagement/meta words (fyp, viral, trending, giveaway, packingorders, ad), or filler (info, article, content, misc, general).',
    'If the item is not in English, translate the meaning and tag the concepts in English.',
    ...(vocab.length
      ? [`Prefer reusing these existing tags when they fit; invent a new tag only if none apply: ${vocab.join(', ')}.`]
      : []),
    ...(candidates.length
      ? [`This item's own hashtags: ${candidates.join(', ')}. Use the ones that are genuinely topical; skip any that are just platform or engagement noise.`]
      : []),
    `Current date/time is ${now}.`,
  ].join('\n')
}

export function classifyUserPrompt({ text, hasImage, isUrl }) {
  const hints = []
  if (hasImage) hints.push('An image is attached to this item.')
  if (isUrl) hints.push('The text is (or contains) a URL.')
  return `${hints.length ? hints.join(' ') + '\n\n' : ''}ITEM:\n${(text || '(no text — image only)').slice(0, 3000)}`
}

// ---- embedding input -----------------------------------------------------
// EmbeddingGemma is prompt-instructed: it was trained with task-specific
// prefixes and expects them at inference time. Embedding a query and a
// document through the same raw-text path — which is what happened here
// before — asks the model to place a question and an answer in the same
// region of the space, when the whole point of the training scheme is that
// they are different KINDS of text and should be encoded differently.
//
// The templates are Google's published ones for the retrieval task:
//   query    → "task: search result | query: {q}"
//   document → "title: none | text: {body}"
// ("title: none" is the documented form for a document with no separate
// title; notes have titles, but they are LLM-generated labels rather than the
// document titles the template means, and they are already inside the body.)
//
// This is keyed on the MODEL, not on the provider, because the template is
// model-specific rather than provider-specific. Locally the embed role can be
// EmbeddingGemma or GTE-Large, and GTE is not prompt-instructed — prefixing
// it would just push 25 characters of boilerplate into every vector. Remotely
// the endpoint may be serving anything at all (nomic, bge, an OpenAI
// text-embedding-*), so the same name check applies there: the remote path
// prefixes when, and only when, the configured model name says EmbeddingGemma.
// Getting it wrong in the "no prefix" direction costs some retrieval quality;
// getting it wrong in the "prefix anyway" direction corrupts every vector, so
// the check fails closed.
const PROMPTED_EMBED_MODEL = /embedding[-_ ]?gemma/i

export function isPromptedEmbedModel(model) {
  return PROMPTED_EMBED_MODEL.test(model || '')
}

// Bump when anything about how a note becomes a vector changes — the prefix
// scheme here, or which fields enrich.js feeds in. Notes record the recipe
// they were embedded under, and a mismatch triggers the same full re-embed a
// model swap does (see enrich.reembedAll). Without it, a library ends up
// holding two incompatible sets of vectors and retrieval silently degrades
// for whichever half is older.
export const EMBED_RECIPE = 'v2-gemma-task-prefix'

// Embedding models run a fixed batch size — EmbeddingGemma's is 1024 tokens —
// and overflowing it is a hard failure, not a truncation: "batch overflow:
// number of tokens in input line (1032) exceeds batch size (1024)", and the
// note silently ends up with no vector at all. A character budget cannot
// prevent that, because characters are not tokens: 4000 chars of English is
// about 1000 tokens, but 4000 chars of Arabic or emoji is several times that.
// This matters more now than it used to — a note's embed input grew to
// include its article body, and a YouTube transcript is 8000 chars by design.
//
// The estimate is deliberately pessimistic. Undershooting costs a little of
// the tail of one long note; overshooting costs the note its entire vector.
const EMBED_TOKEN_BUDGET = 880 // of 1024, leaving room for the prefix and specials

function tokenCost(code) {
  // Latin text averages ~4 chars/token; 3.6 is that with margin. Anything
  // outside ASCII (CJK, Arabic, and each half of an emoji's surrogate pair)
  // is charged a full token, which is roughly what these tokenizers do.
  return code < 128 ? 1 / 3.6 : 1
}

// Truncate to an estimated token budget, never splitting a surrogate pair.
export function clipToTokens(text, maxTokens = EMBED_TOKEN_BUDGET) {
  const s = text || ''
  let cost = 0
  for (let i = 0; i < s.length; i++) {
    cost += tokenCost(s.charCodeAt(i))
    if (cost > maxTokens) return clip(s, i)
  }
  return s
}

export function embedInput(text, { mode = 'document', model = '' } = {}) {
  const body = (text || '').trim()
  if (!isPromptedEmbedModel(model)) return body
  return mode === 'query' ? `task: search result | query: ${body}` : `title: none | text: ${body}`
}

export function answerSystemPrompt() {
  return [
    'You are the assistant for a personal notes app.',
    "Answer the user's question using ONLY the saved notes provided as context.",
    'Describe the actual content of the relevant note(s) — for an image, say what it depicts; for a link, what it is; for code, the gist. Do NOT just say "see note [2]"; the note is shown to the user as a card, so summarise what they will find there.',
    'Cite each note you use with its bracket number, e.g. [2], so the matching card is highlighted.',
    "If the notes don't contain the answer, say so plainly and suggest what to save.",
    'Be concise and direct.',
  ].join('\n')
}

// ---- answer context ------------------------------------------------------
// A note's EMBEDDING is built from title + summary + content + siteTitle +
// siteDesc + article + thumbnail description + tags (see enrich.js's richText
// and toEmbed assembly). This block must show the answer model the SAME
// fields, or retrieval and answering disagree: a saved reel is found on the
// strength of its caption or its thumbnail description, and the model that
// has to describe it then sees only `content` — which for a saved link is
// just the URL again (42 chars on average in a real library). Symmetry
// between what was embedded and what is shown is the entire point of this
// function.
//
// Budgets are chars, sized against the LLM's 8192-token ctx (see local.js's
// ctx_size): ~4 chars/token puts a full CONTEXT_CHARS block at roughly 3k
// tokens, leaving the system prompt, history, question and the generated
// answer comfortable room. Per note the budget shrinks as k grows so a large
// top-k trims every note rather than silently dropping the tail ones — a
// dropped note would still be numbered and shown as a card to the user while
// being invisible to the model.
const CONTEXT_CHARS = 12000
const MAX_NOTE_CHARS = 1200
const MIN_NOTE_CHARS = 400
const ARTICLE_CHARS = 600 // article bodies run to 8000; an excerpt is enough

// Truncate without ever splitting a surrogate pair.
//
// A plain .slice() cuts by UTF-16 code unit, so a cut landing between the two
// halves of an astral character leaves a LONE SURROGATE — which is not valid
// UTF-8 and is rejected outright by strict consumers. This is not theoretical
// and not rare: social captions are full of emoji, and of the decorative
// Mathematical-Bold-Italic alphabet (U+1D400 block) that reel captions use
// for styled text. A single such caption reaching the prompt mid-character
// took the whole answer down with "formatPrompt: Invalid input format".
export function clip(text, max) {
  if (!text || text.length <= max) return text || ''
  const last = text.charCodeAt(max - 1)
  // A high surrogate in the final position means its partner is the character
  // being cut off — drop it too.
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max
  return text.slice(0, end)
}

// Pure: one note → its labelled context body. Exported for tests.
//
// Duplicates are dropped rather than repeated, because these fields overlap
// heavily in practice: an Instagram note's `summary` is often the LLM's
// rewrite of its caption, `siteTitle` frequently equals `title`, and a saved
// link's `content` is character-for-character its `url`. Repeating the same
// sentence three times spends the note's budget without adding a single new
// retrieval-relevant fact.
export function noteContextBody(note) {
  const lines = []
  const seen = new Set([(note.title || '').trim().toLowerCase()])
  const add = (label, value) => {
    const text = (value || '').toString().replace(/\s+/g, ' ').trim()
    if (!text) return
    const key = text.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    lines.push(label ? `${label}: ${text}` : text)
  }
  add('', note.summary)
  add('', note.siteTitle)
  // Labelled, so the model can tell creator-written text from a machine
  // description of a video frame and weight them accordingly.
  add('Caption', note.siteDesc)
  add('Article', clip(note.article, ARTICLE_CHARS))
  add('Thumbnail', note.thumbDescription)
  add('Description', note.description)
  // `content` IS the url for a saved link — adding it would just print the
  // URL twice, once unlabelled.
  if (note.content !== note.url) add('', note.content)
  add('Tags', (note.tags || []).join(', '))
  return lines.join('\n')
}

// Pure: the tail of a chat, as the answer prompt sees it. Exported for tests.
//
// Only the last few turns, and each one clipped: a chat can run to dozens of
// exchanges, and the answer model's context is already carrying ten notes.
// The point is not to replay the conversation — it is to resolve the pronoun
// in "what else did they make?", which the immediately preceding turn almost
// always supplies.
export function formatHistory(history, { turns = HISTORY_TURNS } = {}) {
  return history
    .slice(-turns * 2)
    .map((m) => `${m.role === 'ai' ? 'Assistant' : 'You'}: ${clip((m.text || '').replace(/\s+/g, ' ').trim(), HISTORY_CHARS)}`)
    .join('\n')
}

export function answerUserPrompt({ question, contextNotes, history = [] }) {
  const perNote = contextNotes.length
    ? Math.min(MAX_NOTE_CHARS, Math.max(MIN_NOTE_CHARS, Math.floor(CONTEXT_CHARS / contextNotes.length)))
    : MAX_NOTE_CHARS
  const context = contextNotes
    .map((n, i) => {
      const date = new Date(n.createdAt).toLocaleDateString()
      // Header and URL are outside the budget: both are short, and the URL is
      // what tells the model whether it is looking at a reel, a repo or an
      // article. Truncation falls on the descriptive body, which degrades
      // gracefully — a clipped caption still says what the note is about.
      const head = `[${i + 1}] (${n.type}, ${n.category}, saved ${date}) ${n.title}`
      const url = n.url ? `\nURL: ${n.url}` : ''
      const body = clip(noteContextBody(n), perNote)
      return `${head}${url}${body ? `\n${body}` : ''}`
    })
    .join('\n\n')
  return [
    // Before the notes, not after: the notes block is the long one, and a
    // model reading top-to-bottom should know what "they" refers to before it
    // starts reading evidence about them.
    ...(history.length ? [`EARLIER IN THIS CONVERSATION:\n${formatHistory(history)}`] : []),
    `SAVED NOTES:\n${context || '(no saved notes yet)'}`,
    `QUESTION: ${question}`,
  ].join('\n\n')
}

// How many previous exchanges the answer prompt carries, and how much of each.
// Three turns is enough to resolve a follow-up without spending the context a
// tenth retrieved note would otherwise use.
const HISTORY_TURNS = 3
const HISTORY_CHARS = 500

// Pure: the text a follow-up question is RETRIEVED with. Prepending the
// previous user turn is the cheap half of the same problem the history block
// solves: "what else did they make?" embeds to nothing useful on its own —
// there is no subject in it — so retrieval would answer a different question
// than the one the model is then asked. Only the previous USER turn is
// prepended, never the assistant's answer: an answer is model-generated prose
// that can be several hundred words about the wrong thing, and folding it into
// the query vector drags retrieval toward whatever it happened to say.
export function retrievalQuery(question, history = []) {
  const lastUser = [...history].reverse().find((m) => m.role === 'user' && (m.text || '').trim())
  if (!lastUser) return question
  return `${clip(lastUser.text.trim(), HISTORY_CHARS)}\n${question}`
}
