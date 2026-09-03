const MAX_NODES = 2000
const MAX_EDGES = 2000
const MAX_ID = 64
const MAX_TEXT = 20000
const MAX_LABEL = 200
const TYPES = new Set(['item', 'text', 'group'])
const SIDES = new Set(['top', 'right', 'bottom', 'left'])

const str = (v, max) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)

function cleanNode(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = str(raw.id, MAX_ID)
  if (!id || !TYPES.has(raw.type)) return null
  const x = num(raw.x), y = num(raw.y), width = num(raw.width), height = num(raw.height)
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null
  const base = { id, type: raw.type, x, y, width, height }
  if (raw.type === 'item') {
    const itemId = str(raw.itemId, MAX_ID)
    return itemId ? { ...base, itemId } : null
  }
  if (raw.type === 'text') {
    return typeof raw.text === 'string' ? { ...base, text: raw.text.slice(0, MAX_TEXT) } : null
  }
  const label = typeof raw.label === 'string' ? raw.label.slice(0, MAX_LABEL) : ''
  return label ? { ...base, label } : base
}

export function sanitizeCanvas(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) return null
  if (input.nodes.length > MAX_NODES || input.edges.length > MAX_EDGES) return null
  const seen = new Set()
  const nodes = []
  for (const raw of input.nodes) {
    const n = cleanNode(raw)
    if (!n || seen.has(n.id)) continue
    seen.add(n.id)
    nodes.push(n)
  }
  const edgeIds = new Set()
  const edges = []
  for (const raw of input.edges) {
    if (!raw || typeof raw !== 'object') continue
    const id = str(raw.id, MAX_ID)
    if (!id || edgeIds.has(id) || !seen.has(raw.fromNode) || !seen.has(raw.toNode)) continue
    edgeIds.add(id)
    const e = { id, fromNode: raw.fromNode, toNode: raw.toNode }
    if (SIDES.has(raw.fromSide)) e.fromSide = raw.fromSide
    if (SIDES.has(raw.toSide)) e.toSide = raw.toSide
    edges.push(e)
  }
  return { nodes, edges }
}
