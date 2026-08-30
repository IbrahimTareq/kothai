// Mindmap.tsx — radial "octopus" visualization of a space. Center = the space;
// branches = groups (by platform / type / tag, toggleable); expanding a branch
// fans out its items. Item clicks open the detail panel. All grouping/layout math
// lives in ../layout/mindmap; this file is the React Flow shell + node rendering.
import { useMemo, useState, useCallback } from 'react'
import { ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, useReactFlow } from '@xyflow/react'
import type { Node, Edge, NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Icon, CAT } from './icons'
import { sourceGlyph, platformBucket, SOURCE_BY_KEY } from '../domain/source'
import { buildTree, computeRadialLayout } from '../layout/mindmap'
import type { GroupBy } from '../layout/mindmap'
import type { UIItem, UIType } from '../types'

const DIMENSIONS: { key: GroupBy; label: string }[] = [
  { key: 'platform', label: 'Platform' },
  { key: 'type', label: 'Type' },
  { key: 'tag', label: 'Tag' },
]

// Centered, invisible handles so radial edges emanate from node centers.
function Ports() {
  return (
    <>
      <Handle type="target" position={Position.Top} className="mm-handle" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className="mm-handle" isConnectable={false} />
    </>
  )
}

function SpaceNode({ data }: NodeProps) {
  return <div className="mm-space">{data.label as string}<Ports /></div>
}

// The branch's icon name, resolved from its group key (= node id): type branches
// use the category glyph, platform branches the source/brand glyph. Tag branches
// (and any bucket without a glyph, e.g. "other") return null and fall back to text.
function groupGlyph(key: string): string | null {
  if (key.startsWith('tag:')) return null
  if (key.startsWith('type:')) return CAT[key.slice(5) as UIType]?.glyph ?? null
  return SOURCE_BY_KEY[key]?.glyph ?? null
}

function GroupNode({ id, data }: NodeProps) {
  const open = data.expanded as boolean
  const label = data.label as string
  const glyph = groupGlyph(id)
  return (
    <div className={'mm-group' + (open ? ' open' : '')} title={label}>
      <span className="mm-group-main">
        {glyph && <span className="mm-group-icon"><Icon name={glyph} size={14} /></span>}
        <span className="mm-group-label">{label}</span>
      </span>
      <span className="mm-group-count mono">{data.count as number}</span>
      <Ports />
    </div>
  )
}

function ItemNode({ data }: NodeProps) {
  const it = data.item as UIItem
  const brand = sourceGlyph(it)
  const thumb = it.thumb || it.img
  const title = it.title || it.name || (it.text || '').slice(0, 40) || 'Untitled'
  return (
    <div className="mm-item" title={title}>
      <div className="mm-item-thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <Icon name={CAT[it.type].glyph} size={16} />}
        {brand && <span className="mm-item-brand"><Icon name={brand} size={11} /></span>}
      </div>
      <div className="mm-item-title">{title}</div>
      <Ports />
    </div>
  )
}

function MoreNode({ data }: NodeProps) {
  return <div className="mm-more">+{data.count as number} more<Ports /></div>
}

// Stable node-type registry (must not be recreated per render).
const nodeTypes = { space: SpaceNode, group: GroupNode, item: ItemNode, more: MoreNode }

interface MindmapProps {
  items: UIItem[]
  spaceName: string
  onExpand: (item: UIItem) => void
}

function MindmapInner({ items, spaceName, onExpand }: MindmapProps) {
  const [groupBy, setGroupBy] = useState<GroupBy>('platform')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [uncapped, setUncapped] = useState<Set<string>>(new Set())
  const { fitView } = useReactFlow()

  const groups = useMemo(() => buildTree(items, groupBy, { platformOf: platformBucket }), [items, groupBy])
  const { nodes, edges } = useMemo(
    () => computeRadialLayout(groups, expanded, { spaceName, uncapped }),
    [groups, expanded, uncapped, spaceName],
  )

  const refit = () => setTimeout(() => fitView({ duration: 300, padding: 0.2 }), 0)
  const changeGroup = (g: GroupBy) => { setGroupBy(g); setExpanded(new Set()); setUncapped(new Set()); refit() }
  const expandAll = () => { setExpanded(new Set(groups.map((g) => g.key))); refit() }
  const collapseAll = () => { setExpanded(new Set()); setUncapped(new Set()); refit() }

  const onNodeClick = useCallback((_evt: unknown, node: Node) => {
    if (node.type === 'group') {
      setExpanded((prev) => {
        const n = new Set(prev)
        if (n.has(node.id)) n.delete(node.id); else n.add(node.id)
        return n
      })
    } else if (node.type === 'item') {
      onExpand((node.data as { item: UIItem }).item)
    } else if (node.type === 'more') {
      setUncapped((prev) => new Set(prev).add((node.data as { groupKey: string }).groupKey))
    }
  }, [onExpand])

  if (items.length === 0) {
    return <div className="mm-empty"><Icon name="spark" size={40} /><p>NOTHING TO MAP YET</p></div>
  }

  return (
    <div className="mm-wrap">
      <div className="mm-bar">
        <div className="mm-dims seg" role="tablist" aria-label="Group by">
          {DIMENSIONS.map((d) => (
            <button key={d.key} role="tab" aria-selected={groupBy === d.key}
              className={'seg-btn' + (groupBy === d.key ? ' on' : '')} onClick={() => changeGroup(d.key)}>{d.label}</button>
          ))}
        </div>
        <div className="mm-levels">
          <button onClick={expandAll}>Expand all</button>
          <button onClick={collapseAll}>Collapse all</button>
        </div>
      </div>
      <div className="mm-canvas">
        <ReactFlow
          key={groupBy}
          nodes={nodes as Node[]}
          edges={edges as Edge[]}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={28} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  )
}

// ReactFlowProvider is required for useReactFlow (fitView) to work.
export function Mindmap(props: MindmapProps) {
  return <ReactFlowProvider><MindmapInner {...props} /></ReactFlowProvider>
}
