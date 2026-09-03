// Canvas.tsx — the freeform board for a space (Milanote-style): member cards,
// text notes and columns on an infinite React Flow surface, with lines drawn
// between them. Geometry and doc conversion live in ../layout/canvas; this
// file is the React Flow shell, the node renderers, and autosave.
//
// Membership decides WHICH cards exist (see reconcile); the canvas only adds
// where they sit. Deleting a card here removes the item from the space.
import { useState, useEffect, useRef, useCallback, useMemo, useContext, createContext } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, NodeResizeControl, ResizeControlVariant,
  ConnectionMode, SelectionMode, MarkerType, applyNodeChanges, applyEdgeChanges, addEdge, useReactFlow,
} from '@xyflow/react'
import type { NodeProps, NodeChange, EdgeChange, Connection, OnBeforeDelete } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { CardInner } from './Cards'
import { Icon } from './icons'
import { sourceGlyph, isMediaFirst } from '../domain/source'
import { EMPTY_DOC, TEXT_W, COL_W, COL_MIN_H, reconcile, toFlow, fromFlow, columnOf, stackColumn, tidy } from '../layout/canvas'
import type { FlowNode, FlowEdge, FlowData } from '../layout/canvas'
import type { CanvasDoc, UIItem } from '../types'

const SAVE_DELAY = 600
const uid = () => Math.random().toString(36).slice(2, 10)

// What node renderers need that must not live in node data (functions, the
// item map). Provided by the shell.
interface Ctx {
  items: Map<string, UIItem>
  setData: (id: string, patch: Partial<FlowData>) => void
  restack: (groupId: string) => void
}
const CanvasCtx = createContext<Ctx>({ items: new Map(), setData: () => {}, restack: () => {} })

const SIDES = [['top', Position.Top], ['right', Position.Right], ['bottom', Position.Bottom], ['left', Position.Left]] as const
// Four ports per node. In Loose connection mode a source handle also accepts
// incoming lines, so one handle type covers both ends of a connection.
function Ports() {
  return <>{SIDES.map(([id, pos]) => <Handle key={id} id={id} type="source" position={pos} className="cv-port" />)}</>
}

// ---- node renderers -------------------------------------------------------

function ItemNode({ data }: NodeProps<FlowNode>) {
  const { items } = useContext(CanvasCtx)
  const it = items.get(String(data.itemId))
  if (!it) return null  // reconcile drops the node on the next pass
  const brand = sourceGlyph(it)
  const headline = it.type === 'link' && !isMediaFirst(it)
  const overlay = brand && !headline ? <span className="card-src" title={brand}><Icon name={brand} size={13} /></span> : undefined
  return (
    <div className={'cv-item item-card type-' + it.type + (headline ? ' linktile' : '')} title={it.title || it.name || ''}>
      <div className="card-content"><CardInner item={it} overlay={overlay} /></div>
      <Ports />
    </div>
  )
}

function TextNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { setData } = useContext(CanvasCtx)
  const ref = useRef<HTMLTextAreaElement>(null)
  // The textarea grows with its content; React Flow measures the node from it.
  useEffect(() => {
    const el = ref.current
    if (el) { el.style.height = '0'; el.style.height = el.scrollHeight + 'px' }
  }, [data.text])
  useEffect(() => { if (data.autoFocus) ref.current?.focus() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={'cv-text' + (selected ? ' selected' : '')}>
      <NodeResizeControl position="right" variant={ResizeControlVariant.Line} resizeDirection="horizontal" minWidth={140} className="cv-resize" />
      {/* nodrag: typing and text selection never move the node; nowheel: scrolling a long note pans nothing */}
      <textarea ref={ref} className="nodrag nowheel" rows={1} placeholder="Write…"
        value={String(data.text ?? '')} onChange={(e) => setData(id, { text: e.target.value })} />
      <Ports />
    </div>
  )
}

function ColumnNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { setData, restack } = useContext(CanvasCtx)
  return (
    <div className={'cv-col' + (selected ? ' selected' : '')}>
      <NodeResizeControl position="right" variant={ResizeControlVariant.Line} resizeDirection="horizontal" minWidth={180}
        className="cv-resize" onResizeEnd={() => restack(id)} />
      {/* The header is the drag handle (see dragHandle in toFlow); the label input opts out with nodrag. */}
      <div className="cv-col-head">
        <span className="cv-col-grip" aria-hidden />
        <input className="nodrag" value={String(data.label ?? '')} placeholder="Column"
          onChange={(e) => setData(id, { label: e.target.value })} />
      </div>
      <Ports />
    </div>
  )
}

// Stable registry (must not be recreated per render).
const nodeTypes = { item: ItemNode, text: TextNode, group: ColumnNode }
const edgeOptions = { markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 } }

// ---- shell ----------------------------------------------------------------

export interface CanvasProps {
  collectionId: string
  items: UIItem[]
  doc: CanvasDoc | undefined
  onSave: (doc: CanvasDoc) => void
  onExpand: (item: UIItem) => void
  onRemoveItem: (itemId: string) => void
}

function CanvasInner({ collectionId, items, doc, onSave, onExpand, onRemoveItem }: CanvasProps) {
  const [nodes, setNodes] = useState<FlowNode[]>([])
  const [edges, setEdges] = useState<FlowEdge[]>([])
  const { fitView, screenToFlowPosition } = useReactFlow<FlowNode, FlowEdge>()
  const wrapRef = useRef<HTMLDivElement>(null)
  const coarse = useMemo(() => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches, [])
  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  // ---- autosave ---------------------------------------------------------
  // Refs so the debounced save and the unmount flush read the latest state
  // and the latest onSave without being re-created on every render.
  const latest = useRef({ nodes, edges })
  latest.current = { nodes, edges }
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)
  const saveNow = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (!dirty.current) return
    dirty.current = false
    onSaveRef.current(fromFlow(latest.current.nodes, latest.current.edges))
  }, [])
  const markDirty = useCallback(() => {
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(saveNow, SAVE_DELAY)
  }, [saveNow])
  useEffect(() => () => saveNow(), [saveNow])  // flush on unmount

  // ---- load, and follow membership ----------------------------------------
  // Server responses never feed back in: once loaded, this component is the
  // authority for the space it shows until the collection id changes.
  const memberKey = items.map((i) => i.id).sort().join('|')
  const loadedFor = useRef<string | null>(null)
  const loadedKey = useRef('')
  useEffect(() => {
    if (loadedFor.current === collectionId) return
    loadedFor.current = collectionId
    loadedKey.current = memberKey
    const before = doc ?? EMPTY_DOC
    const d = reconcile(before, items)
    const f = toFlow(d)
    setNodes(f.nodes)
    setEdges(f.edges)
    if (d.nodes.length !== before.nodes.length) markDirty()  // first open laid cards out: keep it
    setTimeout(() => fitView({ padding: 0.2 }), 0)
    // Flush THIS space's edits when we leave it — captured directly (not via
    // onSaveRef) so a same-render onSave swap on collectionId change can't
    // route a stale edit to the next space's save callback.
    return () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
      if (!dirty.current) return
      dirty.current = false
      onSave(fromFlow(latest.current.nodes, latest.current.edges))
    }
  }, [collectionId])  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (loadedFor.current !== collectionId || memberKey === loadedKey.current) return
    loadedKey.current = memberKey
    const { nodes: pn, edges: pe } = latest.current
    const before = fromFlow(pn, pe)
    let after = reconcile(before, items)
    if (after.nodes.length < before.nodes.length) {
      for (const g of after.nodes.filter((n) => n.type === 'group')) after = stackColumn(after, g.id)
    }
    const f = toFlow(after, pn)
    setNodes(f.nodes)
    setEdges(f.edges)
    markDirty()
  }, [memberKey])  // eslint-disable-line react-hooks/exhaustive-deps

  // Run a doc-space transform (layout/canvas.ts) against the live flow state.
  const applyDoc = useCallback((fn: (d: CanvasDoc) => CanvasDoc, save = true) => {
    const { nodes: pn, edges: pe } = latest.current
    const f = toFlow(fn(fromFlow(pn, pe)), pn)
    setNodes(f.nodes)
    setEdges(f.edges)
    if (save) markDirty()
  }, [markDirty])

  // ---- change handlers ------------------------------------------------------
  // Columns whose children were just measured (a card's thumbnail arrived,
  // a note grew): restack them once the new sizes are in state.
  const pendingStack = useRef(new Set<string>())
  useEffect(() => {
    if (!pendingStack.current.size) return
    const ids = [...pendingStack.current]
    pendingStack.current.clear()
    applyDoc((d) => ids.reduce((acc, g) => stackColumn(acc, g), d), false)
  }, [nodes, applyDoc])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const settled = changes.some((c) => (c.type === 'position' && c.dragging === false) || c.type === 'remove')
    const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
    const measured = new Set(changes.filter((c) => c.type === 'dimensions').map((c) => c.id))
    setNodes((prev) => {
      // A deleted column leaves its children behind at their absolute spot.
      const gone = new Map(prev.filter((n) => n.type === 'group' && removed.has(n.id)).map((n) => [n.id, n]))
      for (const n of prev) if (measured.has(n.id) && n.parentId) pendingStack.current.add(n.parentId)
      return applyNodeChanges(changes, prev).map((n) => {
        const p = n.parentId ? gone.get(n.parentId) : undefined
        return p ? { ...n, parentId: undefined, position: { x: p.position.x + n.position.x, y: p.position.y + n.position.y } } : n
      })
    })
    if (settled) markDirty()
  }, [markDirty])

  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    setEdges((prev) => applyEdgeChanges(changes, prev))
    if (changes.some((c) => c.type === 'remove')) markDirty()
  }, [markDirty])

  const onConnect = useCallback((c: Connection) => {
    if (c.source === c.target) return
    setEdges((prev) => addEdge({ ...c, id: 'e:' + uid() }, prev))
    markDirty()
  }, [markDirty])

  // Dropping into or out of a column: containment is recomputed by toFlow, so
  // this only has to restack every column touched (old parent and new).
  const onNodeDragStop = useCallback((_e: unknown, _n: FlowNode, dragged: FlowNode[]) => {
    const touched = new Set(dragged.map((n) => n.parentId).filter((x): x is string => !!x))
    applyDoc((d) => {
      for (const n of dragged) { const g = columnOf(d, n.id); if (g) touched.add(g) }
      let out = d
      for (const g of touched) out = stackColumn(out, g)
      return out
    })
  }, [applyDoc])

  // Backspace/Delete: notes, columns and lines go; a column's children stay;
  // a selected card is removed from the space (reconcile then drops its node).
  const onBeforeDelete: OnBeforeDelete<FlowNode, FlowEdge> = useCallback(async ({ nodes: del, edges: delEdges }) => {
    const groups = new Set(del.filter((n) => n.type === 'group').map((n) => n.id))
    const explicit = new Set(latest.current.nodes.filter((n) => n.selected).map((n) => n.id))
    const keep: FlowNode[] = []
    for (const n of del) {
      if (n.type === 'item') { if (explicit.has(n.id)) onRemoveItem(String(n.data.itemId)); continue }
      if (n.parentId && groups.has(n.parentId) && !explicit.has(n.id)) continue
      keep.push(n)
    }
    const removedIds = new Set(keep.map((n) => n.id))
    return { nodes: keep, edges: delEdges.filter((e) => e.selected || removedIds.has(e.source) || removedIds.has(e.target)) }
  }, [onRemoveItem])

  // ---- commands ---------------------------------------------------------------
  const centre = useCallback(() => {
    const r = wrapRef.current?.getBoundingClientRect()
    return screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 0) / 2, y: (r?.top ?? 0) + (r?.height ?? 0) / 2 })
  }, [screenToFlowPosition])

  const addText = useCallback((at: { x: number; y: number }) => {
    setNodes((prev) => [
      ...prev.map((n) => (n.selected ? { ...n, selected: false } : n)),
      { id: 'n:' + uid(), type: 'text', position: at, width: TEXT_W, selected: true, data: { kind: 'text', text: '', h: 48, autoFocus: true } },
    ])
    markDirty()
  }, [markDirty])

  const addColumn = useCallback(() => {
    const at = centre()
    setNodes((prev) => [
      { id: 'n:' + uid(), type: 'group', position: { x: at.x - COL_W / 2, y: at.y - COL_MIN_H / 2 }, width: COL_W, height: COL_MIN_H,
        dragHandle: '.cv-col-head', data: { kind: 'group', label: '', h: COL_MIN_H } },
      ...prev,  // groups stay ahead of their (future) children
    ])
    markDirty()
  }, [centre, markDirty])

  const setData = useCallback((id: string, patch: Partial<FlowData>) => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)))
    markDirty()
  }, [markDirty])
  const restack = useCallback((gid: string) => applyDoc((d) => stackColumn(d, gid)), [applyDoc])
  const ctx = useMemo<Ctx>(() => ({ items: itemsById, setData, restack }), [itemsById, setData, restack])

  const onDoubleClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return
    addText(screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }
  // Keyboard on the board (not inside a note or label): Escape clears the
  // selection, Enter opens a single selected card. Double-click opens too.
  const onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT') return
    if (e.key === 'Escape') setNodes((p) => p.map((n) => (n.selected ? { ...n, selected: false } : n)))
    if (e.key === 'Enter') {
      const sel = latest.current.nodes.filter((n) => n.selected)
      if (sel.length === 1 && sel[0].type === 'item') { const it = itemsById.get(String(sel[0].data.itemId)); if (it) onExpand(it) }
    }
  }
  const onNodeDoubleClick = useCallback((_e: unknown, n: FlowNode) => {
    if (n.type !== 'item') return
    const it = itemsById.get(String(n.data.itemId))
    if (it) onExpand(it)
  }, [itemsById, onExpand])

  return (
    <CanvasCtx.Provider value={ctx}>
      <div className="cv-wrap">
        <div className="cv-bar">
          <div className="cv-add">
            <button onClick={() => addText(centre())}>+ Note</button>
            <button onClick={addColumn}>+ Column</button>
          </div>
          <div className="cv-cmds">
            <button onClick={() => { applyDoc(tidy); setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 0) }}>Tidy</button>
          </div>
        </div>
        <div className="cv-canvas" ref={wrapRef} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown}>
          <ReactFlow<FlowNode, FlowEdge>
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeDragStop={onNodeDragStop} onNodeDoubleClick={onNodeDoubleClick} onBeforeDelete={onBeforeDelete}
            connectionMode={ConnectionMode.Loose} defaultEdgeOptions={edgeOptions}
            // Milanote/Figma feel: scroll pans, pinch zooms, dragging empty space
            // box-selects; middle/right button pans. Touch: drag pans, no box select.
            panOnScroll zoomOnScroll={false} zoomOnPinch zoomOnDoubleClick={false}
            selectionOnDrag={!coarse} panOnDrag={coarse ? true : [1, 2]} selectionMode={SelectionMode.Partial}
            snapToGrid snapGrid={[8, 8]} deleteKeyCode={['Backspace', 'Delete']}
            minZoom={0.1} maxZoom={2} proOptions={{ hideAttribution: true }}
          >
            <Background gap={28} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {nodes.length === 0 && <p className="cv-hint">Add items from Everything, or double-click to write a note</p>}
        </div>
      </div>
    </CanvasCtx.Provider>
  )
}

// ReactFlowProvider is required for useReactFlow to work.
export function Canvas(props: CanvasProps) {
  return <ReactFlowProvider><CanvasInner {...props} /></ReactFlowProvider>
}
