// canvas.ts — pure geometry for the space canvas: row packing, membership
// reconciliation, frame containment, and the conversion between the persisted
// JSON-Canvas-style doc (absolute coordinates) and React Flow's node list
// (children positioned relative to their frame). No React, no DOM;
// the only import from @xyflow/react is type-only so node --test can load it.
import type { Node, Edge } from '@xyflow/react'
import type { CanvasDoc, CanvasNode, CanvasSide } from '../types.ts'

export const ITEM_W = 220 // member cards are a fixed width
export const TEXT_W = 220 // default text note width (resizable)
export const FRAME_W = 480 // default size of an empty frame (resizable)
export const FRAME_H = 320
export const FRAME_HEAD = 36 // frame title strip height; must match .cv-frame-head in canvas.css
export const FRAME_PAD = 24 // margin a new frame leaves round the selection it wraps
export const GAP = 24
const PACK_MAX_W = 1200
export const DEFAULT_H = 160 // assumed card height until React Flow has measured it

export const EMPTY_DOC: CanvasDoc = { nodes: [], edges: [] }

const itemNodeId = (itemId: string) => `item:${itemId}`

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function bounds(nodes: CanvasNode[]): Bounds | null {
  if (!nodes.length) return null
  const b: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const n of nodes) {
    b.minX = Math.min(b.minX, n.x)
    b.minY = Math.min(b.minY, n.y)
    b.maxX = Math.max(b.maxX, n.x + n.width)
    b.maxY = Math.max(b.maxY, n.y + n.height)
  }
  return b
}

export interface PackOpts {
  originX?: number
  originY?: number
  maxWidth?: number
  gap?: number
}

// Row-wrapping layout in input order: x advances by width + gap and wraps when
// the next node would cross maxWidth; a row is as tall as its tallest node.
// Returns repositioned copies; the first node of a row never wraps.
export function flowPack(nodes: CanvasNode[], opts: PackOpts = {}): CanvasNode[] {
  const ox = opts.originX ?? 0
  const oy = opts.originY ?? 0
  const maxW = opts.maxWidth ?? PACK_MAX_W
  const gap = opts.gap ?? GAP
  let x = ox,
    y = oy,
    rowH = 0
  return nodes.map(n => {
    if (x > ox && x + n.width > ox + maxW) {
      x = ox
      y += rowH + gap
      rowH = 0
    }
    const placed = { ...n, x, y }
    x += n.width + gap
    rowH = Math.max(rowH, n.height)
    return placed
  })
}

// Membership is the source of truth for WHICH cards exist: every member gets
// exactly one item node, and cards for departed members go, along with any
// edge touching them. New members are packed in a row below the current
// content (bottom-left) so additions land somewhere visible without covering
// existing work; on an empty doc everything packs from the origin, which is
// how a pre-canvas space gets a tidy grid on first open.
export function reconcile(doc: CanvasDoc, items: { id: string }[]): CanvasDoc {
  const members = new Set(items.map(i => i.id))
  const kept = doc.nodes.filter(n => n.type !== 'item' || members.has(n.itemId))
  const have = new Set<string>()
  for (const n of kept) if (n.type === 'item') have.add(n.itemId)
  const fresh: CanvasNode[] = items
    .filter(i => !have.has(i.id))
    .map(i => ({ id: itemNodeId(i.id), type: 'item', itemId: i.id, x: 0, y: 0, width: ITEM_W, height: DEFAULT_H }))
  const b = bounds(kept)
  const placed = fresh.length ? flowPack(fresh, b ? { originX: b.minX, originY: b.maxY + GAP } : {}) : []
  const nodes = [...kept, ...placed]
  const ids = new Set(nodes.map(n => n.id))
  const edges = doc.edges.filter(e => ids.has(e.fromNode) && ids.has(e.toNode))
  return { nodes, edges }
}

// --- frames ------------------------------------------------------------------
// A frame is a JSON Canvas `group`: a labelled rectangle whose contents are
// whatever sits inside it. Contents keep their own positions and sizes.

function inside(n: CanvasNode, g: CanvasNode): boolean {
  const cx = n.x + n.width / 2
  const cy = n.y + n.height / 2
  return cx >= g.x && cx <= g.x + g.width && cy >= g.y && cy <= g.y + g.height
}

// The frame a node sits in: the smallest group whose rectangle contains the
// node's centre, or null. Frames never nest, so a frame is never a child.
export function frameOf(doc: CanvasDoc, nodeId: string): string | null {
  const n = doc.nodes.find(x => x.id === nodeId)
  if (!n || n.type === 'group') return null
  let best: CanvasNode | null = null
  for (const g of doc.nodes) {
    if (g.type !== 'group' || !inside(n, g)) continue
    if (!best || g.width * g.height < best.width * best.height) best = g
  }
  return best ? best.id : null
}

// The rectangle for a new frame wrapping `ids`, with room above for its title
// strip; selected frames are skipped since frames never nest. Null when
// nothing wrappable is selected.
export function frameAround(
  doc: CanvasDoc,
  ids: string[],
): { x: number; y: number; width: number; height: number } | null {
  const want = new Set(ids)
  const b = bounds(doc.nodes.filter(n => want.has(n.id) && n.type !== 'group'))
  if (!b) return null
  return {
    x: b.minX - FRAME_PAD,
    y: b.minY - FRAME_PAD - FRAME_HEAD,
    width: b.maxX - b.minX + 2 * FRAME_PAD,
    height: b.maxY - b.minY + 2 * FRAME_PAD + FRAME_HEAD,
  }
}

// Re-packs every top-level node (anything not inside a frame) in reading
// order — rows of ~50px, then left to right — from the content's top-left.
// Frame contents are not re-laid; they move with their frame.
export function tidy(doc: CanvasDoc): CanvasDoc {
  const parentOf = new Map<string, string | null>(doc.nodes.map(n => [n.id, frameOf(doc, n.id)]))
  const top = doc.nodes.filter(n => parentOf.get(n.id) === null)
  const row = (n: CanvasNode) => Math.round(n.y / 50)
  const ordered = [...top].sort((a, b) => row(a) - row(b) || a.x - b.x)
  const b = bounds(top)
  const packed = flowPack(ordered, b ? { originX: b.minX, originY: b.minY } : {})
  const delta = new Map(packed.map((p, i) => [p.id, { dx: p.x - ordered[i].x, dy: p.y - ordered[i].y }]))
  return {
    ...doc,
    nodes: doc.nodes.map(n => {
      const d = delta.get(n.id) ?? delta.get(parentOf.get(n.id) ?? '')
      return d ? { ...n, x: n.x + d.dx, y: n.y + d.dy } : n
    }),
  }
}

// --- React Flow conversion ---------------------------------------------------

// What a node renderer gets as `data`. Functions and the item map stay out of
// here (they come via context) so the flow state is plain data.
export interface FlowData {
  kind: CanvasNode['type']
  itemId?: string
  text?: string
  label?: string
  h: number // last known height, used until React Flow measures
  autoFocus?: boolean // a freshly created note focuses its textarea once
  [k: string]: unknown
}
export type FlowNode = Node<FlowData, CanvasNode['type']>
export type FlowEdge = Edge

function dataOf(n: CanvasNode): FlowData {
  if (n.type === 'item') return { kind: 'item', itemId: n.itemId, h: n.height }
  if (n.type === 'text') return { kind: 'text', text: n.text, h: n.height }
  return { kind: 'group', label: n.label ?? '', h: n.height }
}

// Doc → React Flow nodes. Children of a frame carry `parentId` and a position
// relative to it so dragging the frame moves its contents. Membership is
// recomputed from geometry on every call, so a drop, a drag out or a shrink
// that leaves a child's centre outside is all the re-parenting there is. Groups come first
// (React Flow wants parents before children). `prev` lets a rebuild keep each
// node's selection and measured size, so a reconcile never flashes or deselects.
export function toFlow(doc: CanvasDoc, prev: FlowNode[] = []): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const byId = new Map(doc.nodes.map(n => [n.id, n]))
  const old = new Map(prev.map(n => [n.id, n]))
  const groupsFirst = [...doc.nodes].sort((a, b) => Number(b.type === 'group') - Number(a.type === 'group'))
  const nodes: FlowNode[] = groupsFirst.map(n => {
    const parentId = frameOf(doc, n.id)
    const p = parentId ? byId.get(parentId) : undefined
    const o = old.get(n.id)
    return {
      id: n.id,
      type: n.type,
      data: dataOf(n),
      position: p ? { x: n.x - p.x, y: n.y - p.y } : { x: n.x, y: n.y },
      width: n.width,
      ...(parentId ? { parentId } : {}),
      ...(n.type === 'group' ? { height: n.height, dragHandle: '.cv-frame-head' } : {}),
      ...(o?.selected ? { selected: true } : {}),
      ...(o?.measured ? { measured: o.measured } : {}),
    }
  })
  const edges: FlowEdge[] = doc.edges.map(e => ({
    id: e.id,
    source: e.fromNode,
    target: e.toNode,
    sourceHandle: e.fromSide ?? null,
    targetHandle: e.toSide ?? null,
  }))
  return { nodes, edges }
}

const SIDES: CanvasSide[] = ['top', 'right', 'bottom', 'left']
const sideOf = (h: string | null | undefined): CanvasSide | undefined =>
  SIDES.includes(h as CanvasSide) ? (h as CanvasSide) : undefined

// React Flow nodes → doc. Positions become absolute; a node's height is what
// React Flow measured (a frame's is the one it was resized to), width is the node's own.
export function fromFlow(nodes: FlowNode[], edges: FlowEdge[]): CanvasDoc {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const abs = (n: FlowNode): { x: number; y: number } => {
    const p = n.parentId ? byId.get(n.parentId) : undefined
    if (!p) return { x: n.position.x, y: n.position.y }
    const pp = abs(p)
    return { x: pp.x + n.position.x, y: pp.y + n.position.y }
  }
  const out: CanvasNode[] = nodes.map(n => {
    const { x, y } = abs(n)
    const width = Math.max(1, Math.round(n.width ?? n.measured?.width ?? ITEM_W))
    const height = Math.max(
      1,
      Math.round((n.type === 'group' ? n.height : undefined) ?? n.measured?.height ?? n.data.h),
    )
    const base = { id: n.id, x: Math.round(x), y: Math.round(y), width, height }
    if (n.type === 'item') return { ...base, type: 'item', itemId: String(n.data.itemId) }
    if (n.type === 'text') return { ...base, type: 'text', text: String(n.data.text ?? '') }
    const label = n.data.label ? String(n.data.label) : undefined
    return label ? { ...base, type: 'group', label } : { ...base, type: 'group' }
  })
  return {
    nodes: out,
    edges: edges.map(e => ({
      id: e.id,
      fromNode: e.source,
      toNode: e.target,
      fromSide: sideOf(e.sourceHandle),
      toSide: sideOf(e.targetHandle),
    })),
  }
}
