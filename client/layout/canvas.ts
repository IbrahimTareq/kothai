// canvas.ts — pure geometry for the space canvas: row packing, membership
// reconciliation, column containment and stacking, and the conversion between
// the persisted JSON-Canvas-style doc (absolute coordinates) and React Flow's
// node list (children positioned relative to their column). No React, no DOM;
// the only import from @xyflow/react is type-only so node --test can load it.
import type { CanvasDoc, CanvasNode } from '../types.ts'

export const ITEM_W = 220      // member cards are a fixed width
export const TEXT_W = 220      // default text note width (resizable)
export const COL_W = 260       // default column width (resizable)
export const COL_MIN_H = 120
export const COL_HEAD = 36     // column header height; must match .cv-col-head in canvas.css
export const COL_PAD = 12
export const GAP = 24
export const PACK_MAX_W = 1200
export const DEFAULT_H = 160   // assumed card height until React Flow has measured it

export const EMPTY_DOC: CanvasDoc = { nodes: [], edges: [] }

export const itemNodeId = (itemId: string) => 'item:' + itemId

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

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

export interface PackOpts { originX?: number; originY?: number; maxWidth?: number; gap?: number }

// Row-wrapping layout in input order: x advances by width + gap and wraps when
// the next node would cross maxWidth; a row is as tall as its tallest node.
// Returns repositioned copies; the first node of a row never wraps.
export function flowPack(nodes: CanvasNode[], opts: PackOpts = {}): CanvasNode[] {
  const ox = opts.originX ?? 0
  const oy = opts.originY ?? 0
  const maxW = opts.maxWidth ?? PACK_MAX_W
  const gap = opts.gap ?? GAP
  let x = ox, y = oy, rowH = 0
  return nodes.map((n) => {
    if (x > ox && x + n.width > ox + maxW) { x = ox; y += rowH + gap; rowH = 0 }
    const placed = { ...n, x, y }
    x += n.width + gap
    rowH = Math.max(rowH, n.height)
    return placed
  })
}
