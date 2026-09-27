// spaceTree.ts — where a space sits among the others. Spaces nest by parentId
// alone (server/data/collections.ts) and arrive as one flat list; every view
// that needs the tree reads it through here.
import type { Collection } from '../types'

type Space = Pick<Collection, 'id' | 'name' | 'parentId'>

// The space and the spaces it sits in, top level first. A parent missing from
// the list ends the path: a deleted space leaves the client's list before the
// refetch that moves its sub-spaces up (data/useCollections.ts).
export function spacePath<T extends Space>(spaces: T[], id: string): T[] {
  const byId = new Map(spaces.map(s => [s.id, s]))
  const path: T[] = []
  for (let at = byId.get(id); at; at = at.parentId ? byId.get(at.parentId) : undefined) path.unshift(at)
  return path
}

// "Travel / Japan". Two sub-spaces can share a name, so anywhere spaces are
// listed flat (the add-to-space menus, Move to) names each by its path.
export const spaceLabel = (spaces: Space[], id: string) =>
  spacePath(spaces, id)
    .map(s => s.name)
    .join(' / ')

// Where space `id` may move: anywhere but itself, the spaces inside it, and
// the parent it already has. The server refuses a loop regardless
// (routes/collections.ts); this keeps the menu from offering one.
export function moveTargets<T extends Space>(spaces: T[], id: string): T[] {
  const parentId = spaces.find(s => s.id === id)?.parentId
  return spaces.filter(s => s.id !== parentId && !spacePath(spaces, s.id).some(a => a.id === id))
}
