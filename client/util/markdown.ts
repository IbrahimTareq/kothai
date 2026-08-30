// markdown.ts — the small subset of Markdown an answer model actually emits.
//
// Answers used to be dropped into the DOM as one raw string, so a model that
// replied with a bullet list, a **bold** phrase or two paragraphs showed its
// own syntax instead of the formatting it meant. This parses just enough —
// paragraphs, headings, lists, fenced code and the three inline marks — and
// leaves anything it doesn't recognise as literal text, so no part of an
// answer can be swallowed by a rule the model didn't intend.
//
// Rendering lives in views/Core.tsx: the parse is kept pure (and free of React)
// so the [n] citation linkifier can run over the text spans afterwards.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'br' }

export type Block =
  | { kind: 'p'; spans: Inline[] }
  | { kind: 'h'; level: number; spans: Inline[] }
  | { kind: 'ul'; items: Inline[][] }
  | { kind: 'ol'; items: Inline[][]; start: number }
  | { kind: 'pre'; text: string; lang: string }

// Inline marks, in priority order: a code span wins over emphasis, and `**`
// is tried before `*` so bold isn't read as two italics. Both emphasis forms
// require a non-space, non-asterisk character at each end, which is what keeps
// arithmetic ("2 * 3 * 4") and stray asterisks from turning into <em>.
const INLINE = /`([^`\n]+)`|\*\*([^*\s]|[^*\s][^*\n]*?[^*\s])\*\*|\*([^*\s]|[^*\s][^*\n]*?[^*\s])\*/g

const FENCE = /^\s*```(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBER = /^\s*(\d{1,9})[.)]\s+(.*)$/
// A horizontal rule carries no information in an answer, and rendering it
// literally ("---") reads as a bug. Recognised only so it can be dropped.
const RULE = /^\s*([-*_])\1{2,}\s*$/

/** Split one line into its inline spans. Never returns a `br`. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  INLINE.lastIndex = 0
  for (let m = INLINE.exec(src); m; m = INLINE.exec(src)) {
    if (m.index > last) out.push({ kind: 'text', text: src.slice(last, m.index) })
    if (m[1] != null) out.push({ kind: 'code', text: m[1] })
    else if (m[2] != null) out.push({ kind: 'strong', text: m[2] })
    else out.push({ kind: 'em', text: m[3] })
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ kind: 'text', text: src.slice(last) })
  return out
}

/** Parse an answer into renderable blocks. Unknown syntax stays literal. */
export function parseMarkdown(src: string): Block[] {
  const lines = (src || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []

  // A run of plain lines is one paragraph. A single newline inside it becomes a
  // hard break rather than a space: models don't hard-wrap at a column, so a
  // lone newline is nearly always a break the model meant.
  const flush = () => {
    if (!para.length) return
    const spans: Inline[] = []
    para.forEach((line, i) => {
      if (i) spans.push({ kind: 'br' })
      spans.push(...parseInline(line))
    })
    blocks.push({ kind: 'p', spans })
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++])
      blocks.push({ kind: 'pre', text: body.join('\n'), lang: fence[1].trim() })
      continue   // i sits on the closing fence (or past the end); the loop steps over it
    }

    if (!line.trim()) { flush(); continue }
    if (RULE.test(line)) { flush(); continue }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'h', level: heading[1].length, spans: parseInline(heading[2].trim()) })
      continue
    }

    // The trailing space in the marker is what separates "- item" from a line
    // that merely opens with **bold**.
    const bullet = BULLET.exec(line)
    if (bullet) { flush(); addItem(blocks, 'ul', parseInline(bullet[1]), 1); continue }

    const numbered = NUMBER.exec(line)
    if (numbered) { flush(); addItem(blocks, 'ol', parseInline(numbered[2]), parseInt(numbered[1], 10)); continue }

    para.push(line)
  }
  flush()
  return blocks
}

// Consecutive list lines join the list already in progress. Nesting is
// flattened: an indented sub-list becomes another item at the same level,
// which loses the hierarchy but never loses the text.
function addItem(blocks: Block[], kind: 'ul' | 'ol', spans: Inline[], start: number) {
  const open = blocks[blocks.length - 1]
  if (open && open.kind === kind) { open.items.push(spans); return }
  if (kind === 'ul') blocks.push({ kind: 'ul', items: [spans] })
  else blocks.push({ kind: 'ol', items: [spans], start })
}
