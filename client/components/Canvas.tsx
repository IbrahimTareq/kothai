// Canvas.tsx — the freeform board for a space (Milanote-style): member cards,
// text notes and frames on an infinite React Flow surface, with lines drawn
// between them. Geometry and doc conversion live in ../layout/canvas; this
// file is the React Flow shell, the node renderers, and autosave.
//
// Membership decides WHICH cards exist (see reconcile); the canvas only adds
// where they sit. Deleting a card here removes the item from the space.
import { useState, useEffect, useRef, useCallback, useMemo, useContext, createContext } from 'react'
import type { KeyboardEvent, MouseEvent } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  NodeResizer,
  NodeResizeControl,
  ResizeControlVariant,
  ConnectionMode,
  SelectionMode,
  MarkerType,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useReactFlow,
} from '@xyflow/react'
import type { NodeProps, NodeChange, EdgeChange, Connection, OnBeforeDelete } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { CardInner } from './Cards'
import { Icon } from './icons'
import { sourceGlyph, isMediaFirst } from '../domain/source'
import { EMPTY_DOC, TEXT_W, FRAME_W, FRAME_H, reconcile, toFlow, fromFlow, frameAround, tidy } from '../layout/canvas'
import type { FlowNode, FlowEdge, FlowData } from '../layout/canvas'
import type { CanvasDoc, UIItem } from '../types'
import { Button } from '../ui/Button'

const SAVE_DELAY = 600
const uid = () => Math.random().toString(36).slice(2, 10)

// What node renderers need that must not live in node data (functions, the
// item map). Provided by the shell.
interface Ctx {
  items: Map<string, UIItem>
  setData: (id: string, patch: Partial<FlowData>) => void
  reparent: () => void
}
const CanvasCtx = createContext<Ctx>({ items: new Map(), setData: () => {}, reparent: () => {} })

const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
] as const
// Four ports per node. In Loose connection mode a source handle also accepts
// incoming lines, so one handle type covers both ends of a connection.
function Ports() {
  return (
    <>
      {SIDES.map(([id, pos]) => (
        <Handle key={id} id={id} type="source" position={pos} className="cv-port" />
      ))}
    </>
  )
}

// ---- node renderers -------------------------------------------------------

function ItemNode({ data }: NodeProps<FlowNode>) {
  const { items } = useContext(CanvasCtx)
  const it = items.get(String(data.itemId))
  if (!it) return null // reconcile drops the node on the next pass
  const brand = sourceGlyph(it)
  const headline = it.type === 'link' && !isMediaFirst(it)
  const overlay =
    brand && !headline ? (
      <span className="card-src" title={brand}>
        <Icon name={brand} size={13} />
      </span>
    ) : undefined
  return (
    <div className={`cv-item item-card type-${it.type}${headline ? ' linktile' : ''}`} title={it.title || ''}>
      <div className="card-content">
        <CardInner item={it} overlay={overlay} />
      </div>
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
    if (el) {
      el.style.height = '0'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [data.text])
  useEffect(() => {
    if (data.autoFocus) ref.current?.focus()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`cv-text${selected ? ' selected' : ''}`}>
      <NodeResizeControl
        position="right"
        variant={ResizeControlVariant.Line}
        resizeDirection="horizontal"
        minWidth={140}
        className="cv-resize"
      />
      {/* nodrag: typing and text selection never move the node; nowheel: scrolling a long note pans nothing */}
      <textarea
        ref={ref}
        className="nodrag nowheel"
        rows={1}
        placeholder="Write…"
        value={String(data.text ?? '')}
        onChange={e => setData(id, { text: e.target.value })}
      />
      <Ports />
    </div>
  )
}

function FrameNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { setData, reparent } = useContext(CanvasCtx)
  return (
    <div className={`cv-frame${selected ? ' selected' : ''}`}>
      {/* Children keep their absolute spots while resizing; on release, anything
          whose centre ended up outside leaves the frame. */}
      <NodeResizer isVisible={selected} minWidth={160} minHeight={96} onResizeEnd={reparent} />
      {/* The title strip is the drag handle (see dragHandle in toFlow). The
          label is nodrag and sized to its text: stretched across the strip it
          left nothing to grab, and the frame could not be moved. */}
      <div className="cv-frame-head">
        <input
          className="nodrag"
          size={Math.max(6, String(data.label ?? '').length + 1)}
          value={String(data.label ?? '')}
          placeholder="Frame"
          onChange={e => setData(id, { label: e.target.value })}
        />
      </div>
      <Ports />
    </div>
  )
}

// Stable registry (must not be recreated per render).
const nodeTypes = { item: ItemNode, text: TextNode, group: FrameNode }
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
  const itemsById = useMemo(() => new Map(items.map(i => [i.id, i])), [items])

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
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (!dirty.current) return
    dirty.current = false
    onSaveRef.current(fromFlow(latest.current.nodes, latest.current.edges))
  }, [])
  const markDirty = useCallback(() => {
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(saveNow, SAVE_DELAY)
  }, [saveNow])
  useEffect(() => () => saveNow(), [saveNow]) // flush on unmount

  // ---- load, and follow membership ----------------------------------------
  // Server responses never feed back in: once loaded, this component is the
  // authority for the space it shows until the collection id changes.
  const memberKey = items
    .map(i => i.id)
    .sort()
    .join('|')
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
    if (d.nodes.length !== before.nodes.length) markDirty() // first open laid cards out: keep it
    setTimeout(() => fitView({ padding: 0.2 }), 0)
    // Flush THIS space's edits when we leave it — captured directly (not via
    // onSaveRef) so a same-render onSave swap on collectionId change can't
    // route a stale edit to the next space's save callback.
    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      if (!dirty.current) return
      dirty.current = false
      onSave(fromFlow(latest.current.nodes, latest.current.edges))
    }
  }, [collectionId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (loadedFor.current !== collectionId || memberKey === loadedKey.current) return
    loadedKey.current = memberKey
    const { nodes: pn, edges: pe } = latest.current
    const f = toFlow(reconcile(fromFlow(pn, pe), items), pn)
    setNodes(f.nodes)
    setEdges(f.edges)
    markDirty()
  }, [memberKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Run a doc-space transform (layout/canvas.ts) against the live flow state.
  const applyDoc = useCallback(
    (fn: (d: CanvasDoc) => CanvasDoc, save = true) => {
      const { nodes: pn, edges: pe } = latest.current
      const f = toFlow(fn(fromFlow(pn, pe)), pn)
      setNodes(f.nodes)
      setEdges(f.edges)
      if (save) markDirty()
    },
    [markDirty],
  )

  // ---- change handlers ------------------------------------------------------
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      // A resize ends with `resizing: false`; without it here a resized frame
      // or note only reached the server if some other edit happened to follow.
      const settled = changes.some(
        c =>
          (c.type === 'position' && c.dragging === false) ||
          (c.type === 'dimensions' && c.resizing === false) ||
          c.type === 'remove',
      )
      const removed = new Set(changes.filter(c => c.type === 'remove').map(c => c.id))
      setNodes(prev => {
        // A deleted frame leaves its children behind at their absolute spot.
        const gone = new Map(prev.filter(n => n.type === 'group' && removed.has(n.id)).map(n => [n.id, n]))
        return applyNodeChanges(changes, prev).map(n => {
          const p = n.parentId ? gone.get(n.parentId) : undefined
          return p
            ? {
                ...n,
                parentId: undefined,
                position: { x: p.position.x + n.position.x, y: p.position.y + n.position.y },
              }
            : n
        })
      })
      if (settled) markDirty()
    },
    [markDirty],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      setEdges(prev => applyEdgeChanges(changes, prev))
      if (changes.some(c => c.type === 'remove')) markDirty()
    },
    [markDirty],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) return
      setEdges(prev => addEdge({ ...c, id: `e:${uid()}` }, prev))
      markDirty()
    },
    [markDirty],
  )

  // Dropping into or out of a frame: toFlow recomputes membership from
  // geometry, so a round trip through the doc is the whole job. Absolute
  // positions don't change, so there is nothing new to save.
  const reparent = useCallback(() => applyDoc(d => d, false), [applyDoc])

  // Backspace/Delete: notes, frames and lines go; a frame's children stay;
  // a selected card is removed from the space (reconcile then drops its node).
  const onBeforeDelete: OnBeforeDelete<FlowNode, FlowEdge> = useCallback(
    async ({ nodes: del, edges: delEdges }) => {
      const groups = new Set(del.filter(n => n.type === 'group').map(n => n.id))
      const explicit = new Set(latest.current.nodes.filter(n => n.selected).map(n => n.id))
      const keep: FlowNode[] = []
      for (const n of del) {
        if (n.type === 'item') {
          if (explicit.has(n.id)) onRemoveItem(String(n.data.itemId))
          continue
        }
        if (n.parentId && groups.has(n.parentId) && !explicit.has(n.id)) continue
        keep.push(n)
      }
      const removedIds = new Set(keep.map(n => n.id))
      return {
        nodes: keep,
        edges: delEdges.filter(e => e.selected || removedIds.has(e.source) || removedIds.has(e.target)),
      }
    },
    [onRemoveItem],
  )

  // ---- commands ---------------------------------------------------------------
  const centre = useCallback(() => {
    const r = wrapRef.current?.getBoundingClientRect()
    return screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 0) / 2, y: (r?.top ?? 0) + (r?.height ?? 0) / 2 })
  }, [screenToFlowPosition])

  const addText = useCallback(
    (at: { x: number; y: number }) => {
      setNodes(prev => [
        ...prev.map(n => (n.selected ? { ...n, selected: false } : n)),
        {
          id: `n:${uid()}`,
          type: 'text',
          position: at,
          width: TEXT_W,
          selected: true,
          data: { kind: 'text', text: '', h: 48, autoFocus: true },
        },
      ])
      markDirty()
    },
    [markDirty],
  )

  // Wraps the selection when there is one, else drops an empty frame at the
  // viewport centre. Either way membership falls out of geometry in toFlow.
  const addFrame = useCallback(() => {
    applyDoc(d => {
      const selected = latest.current.nodes.filter(n => n.selected).map(n => n.id)
      const at = centre()
      const rect = frameAround(d, selected) ?? {
        x: at.x - FRAME_W / 2,
        y: at.y - FRAME_H / 2,
        width: FRAME_W,
        height: FRAME_H,
      }
      return { ...d, nodes: [{ id: `n:${uid()}`, type: 'group', ...rect }, ...d.nodes] }
    })
  }, [applyDoc, centre])

  const setData = useCallback(
    (id: string, patch: Partial<FlowData>) => {
      setNodes(prev => prev.map(n => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)))
      markDirty()
    },
    [markDirty],
  )
  const ctx = useMemo<Ctx>(() => ({ items: itemsById, setData, reparent }), [itemsById, setData, reparent])

  const onDoubleClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return
    addText(screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }
  // Keyboard on the board (not inside a note or label): Escape clears the
  // selection, Enter opens a single selected card. Double-click opens too.
  const onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT') return
    if (e.key === 'Escape') setNodes(p => p.map(n => (n.selected ? { ...n, selected: false } : n)))
    if (e.key === 'Enter') {
      const sel = latest.current.nodes.filter(n => n.selected)
      if (sel.length === 1 && sel[0].type === 'item') {
        const it = itemsById.get(String(sel[0].data.itemId))
        if (it) onExpand(it)
      }
    }
  }
  const onNodeDoubleClick = useCallback(
    (_e: unknown, n: FlowNode) => {
      if (n.type !== 'item') return
      const it = itemsById.get(String(n.data.itemId))
      if (it) onExpand(it)
    },
    [itemsById, onExpand],
  )

  return (
    <CanvasCtx.Provider value={ctx}>
      <div className="cv-wrap">
        <div className="cv-bar">
          <div className="cv-add">
            <Button size="xs" tone="ghost" onClick={() => addText(centre())}>
              + Note
            </Button>
            <Button size="xs" tone="ghost" onClick={addFrame}>
              + Frame
            </Button>
          </div>
          <div className="cv-cmds">
            <Button
              size="xs"
              tone="ghost"
              onClick={() => {
                applyDoc(tidy)
                setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 0)
              }}
            >
              Tidy
            </Button>
          </div>
        </div>
        <div className="cv-canvas" ref={wrapRef} onDoubleClick={onDoubleClick} onKeyDown={onKeyDown}>
          <ReactFlow<FlowNode, FlowEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={reparent}
            onNodeDoubleClick={onNodeDoubleClick}
            onBeforeDelete={onBeforeDelete}
            connectionMode={ConnectionMode.Loose}
            defaultEdgeOptions={edgeOptions}
            // Milanote/Figma feel: scroll pans, pinch zooms, dragging empty space
            // box-selects; middle/right button pans. Touch: drag pans, no box select.
            panOnScroll
            zoomOnScroll={false}
            zoomOnPinch
            zoomOnDoubleClick={false}
            selectionOnDrag={!coarse}
            panOnDrag={coarse ? true : [1, 2]}
            selectionMode={SelectionMode.Partial}
            snapToGrid
            snapGrid={[8, 8]}
            deleteKeyCode={['Backspace', 'Delete']}
            minZoom={0.1}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
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
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}
