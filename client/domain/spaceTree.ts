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

// Every space right under its parent, for the menus that list spaces flat.
// Compared name by name down the path, not as label text: as text, "Travel
// (old)" sorted between "Travel" and "Travel / Asia" and split the family.
// The id breaks a tie so two sub-spaces sharing a name keep their own
// children beneath them.
export function byPath<T extends Space>(spaces: T[], all: Space[]): T[] {
  const order = (pa: Space[], pb: Space[]) => {
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const c = pa[i].name.localeCompare(pb[i].name) || pa[i].id.localeCompare(pb[i].id)
      if (c) return c
    }
    return pa.length - pb.length
  }
  return spaces
    .map(s => ({ s, path: spacePath(all, s.id) }))
    .sort((a, b) => order(a.path, b.path))
    .map(x => x.s)
}
