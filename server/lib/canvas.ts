const MAX_NODES = 2000
const MAX_EDGES = 2000
const MAX_ID = 64
const MAX_TEXT = 20000
const MAX_LABEL = 200
const TYPES = new Set(['item', 'text', 'group'])
const SIDES = new Set(['top', 'right', 'bottom', 'left'])

type NodeType = 'item' | 'text' | 'group'
type Side = 'top' | 'right' | 'bottom' | 'left'

interface NodeBase {
  id: string
  x: number
  y: number
  width: number
  height: number
}
type CanvasNode =
  | (NodeBase & { type: 'item'; itemId: string })
  | (NodeBase & { type: 'text'; text: string })
  | (NodeBase & { type: 'group'; label?: string })

interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: Side
  toSide?: Side
}

interface CanvasDoc {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
const isNodeType = (v: unknown): v is NodeType => typeof v === 'string' && TYPES.has(v)
const isSide = (v: unknown): v is Side => typeof v === 'string' && SIDES.has(v)

function cleanNode(raw: unknown): CanvasNode | null {
  if (!raw || typeof raw !== 'object') return null
  const node = raw as Record<string, unknown>
  const id = str(node.id, MAX_ID)
  const type = node.type
  if (!id || !isNodeType(type)) return null
  const x = num(node.x),
    y = num(node.y),
    width = num(node.width),
    height = num(node.height)
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null
  const base = { id, type, x, y, width, height }
  if (type === 'item') {
    const itemId = str(node.itemId, MAX_ID)
    return itemId ? { ...base, type, itemId } : null
  }
  if (type === 'text') {
    return typeof node.text === 'string' ? { ...base, type, text: node.text.slice(0, MAX_TEXT) } : null
  }
  const label = typeof node.label === 'string' ? node.label.slice(0, MAX_LABEL) : ''
  return label ? { ...base, type, label } : { ...base, type }
}

export function sanitizeCanvas(input: unknown): CanvasDoc | null {
  const doc = input as { nodes?: unknown; edges?: unknown } | null | undefined
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) return null
  if (doc.nodes.length > MAX_NODES || doc.edges.length > MAX_EDGES) return null
  const seen = new Set<string>()
  const nodes: CanvasNode[] = []
  for (const raw of doc.nodes) {
    const n = cleanNode(raw)
    if (!n || seen.has(n.id)) continue
    seen.add(n.id)
    nodes.push(n)
  }
  const edgeIds = new Set<string>()
  const edges: CanvasEdge[] = []
  for (const raw of doc.edges) {
    if (!raw || typeof raw !== 'object') continue
    const { id: rawId, fromNode, toNode, fromSide, toSide } = raw as Record<string, unknown>
    const id = str(rawId, MAX_ID)
    // typeof guards only narrow for the compiler: `seen` holds node ids, which
    // are strings, so a non-string here never matched in the first place.
    if (!id || edgeIds.has(id) || typeof fromNode !== 'string' || !seen.has(fromNode)) continue
    if (typeof toNode !== 'string' || !seen.has(toNode)) continue
    edgeIds.add(id)
    const e: CanvasEdge = { id, fromNode, toNode }
    if (isSide(fromSide)) e.fromSide = fromSide
    if (isSide(toSide)) e.toSide = toSide
    edges.push(e)
  }
  return { nodes, edges }
}
