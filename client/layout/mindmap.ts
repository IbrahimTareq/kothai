// mindmap.ts — pure grouping + radial layout for the space mindmap. No React and
// no DOM; the only runtime dependency is d3-hierarchy (layout math). Platform
// grouping is injected (BuildOpts.platformOf) so this module stays testable in
// isolation from source.ts.
import { hierarchy, tree } from 'd3-hierarchy'
import type { UIItem } from '../types'

export type GroupBy = 'platform' | 'type' | 'tag'

export interface MindGroup {
  key: string
  label: string
  items: UIItem[]
  count: number
}

export interface BuildOpts {
  platformOf: (item: UIItem) => { key: string; label: string }
}

const TYPE_LABELS: Record<string, string> = {
  video: 'Video', link: 'Link', image: 'Image', code: 'Code', note: 'Note',
}

// The branch(es) an item belongs to for the chosen dimension. Tag items can
// belong to several; platform/type belong to exactly one.
function keysFor(item: UIItem, groupBy: GroupBy, opts: BuildOpts): { key: string; label: string }[] {
  if (groupBy === 'platform') return [opts.platformOf(item)]
  if (groupBy === 'type') return [{ key: 'type:' + item.type, label: TYPE_LABELS[item.type] ?? item.type }]
  if (!item.tags || item.tags.length === 0) return [{ key: 'tag:untagged', label: 'untagged' }]
  return item.tags.map((t) => ({ key: 'tag:' + t, label: t }))
}

// Groups items into branches, preserving input (newest-first) order within each
// branch. Branches are sorted by descending count, then label.
export function buildTree(items: UIItem[], groupBy: GroupBy, opts: BuildOpts): MindGroup[] {
  const map = new Map<string, MindGroup>()
  for (const item of items) {
    for (const { key, label } of keysFor(item, groupBy, opts)) {
      let g = map.get(key)
      if (!g) { g = { key, label, items: [], count: 0 }; map.set(key, g) }
      g.items.push(item)
      g.count++
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

// --- radial layout ---------------------------------------------------------

export interface FlowNode {
  id: string
  type: 'space' | 'group' | 'item' | 'more'
  position: { x: number; y: number }
  data: Record<string, unknown>
}
export interface FlowEdge { id: string; source: string; target: string }

interface HierNode {
  id: string
  kind: 'space' | 'group' | 'item' | 'more'
  data: Record<string, unknown>
  children?: HierNode[]
}

export interface LayoutOpts {
  spaceName: string
  cap?: number            // max item leaves per branch before "+N more"
  uncapped?: Set<string>  // branch keys whose cap has been lifted
  ring?: number           // px between depth rings
}

const DEFAULT_CAP = 12
const DEFAULT_RING = 240

// Builds the space -> branch -> item hierarchy for the currently expanded
// branches, then positions each node on concentric rings by depth (radial tree).
export function computeRadialLayout(
  groups: MindGroup[],
  expanded: Set<string>,
  opts: LayoutOpts,
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const cap = opts.cap ?? DEFAULT_CAP
  const ring = opts.ring ?? DEFAULT_RING
  const uncapped = opts.uncapped ?? new Set<string>()

  const root: HierNode = {
    id: 'root', kind: 'space', data: { label: opts.spaceName },
    children: groups.map((g) => {
      const open = expanded.has(g.key)
      let kids: HierNode[] = []
      if (open) {
        const shown = uncapped.has(g.key) ? g.items : g.items.slice(0, cap)
        kids = shown.map((it) => ({ id: 'item:' + it.id + ':' + g.key, kind: 'item' as const, data: { item: it } }))
        const hidden = g.items.length - shown.length
        if (hidden > 0) kids.push({ id: 'more:' + g.key, kind: 'more' as const, data: { groupKey: g.key, count: hidden } })
      }
      return { id: g.key, kind: 'group' as const, data: { label: g.label, count: g.count, expanded: open }, children: kids }
    }),
  }

  const h = hierarchy<HierNode>(root)
  tree<HierNode>().size([2 * Math.PI, 1])(h) // x = angle spread; depth drives radius

  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  h.each((d) => {
    const r = d.depth * ring
    const angle = (d.x ?? 0) - Math.PI / 2
    nodes.push({
      id: d.data.id,
      type: d.data.kind,
      position: { x: r * Math.cos(angle), y: r * Math.sin(angle) },
      data: d.data.data,
    })
    if (d.parent) {
      edges.push({ id: d.parent.data.id + '->' + d.data.id, source: d.parent.data.id, target: d.data.id })
    }
  })
  return { nodes, edges }
}
