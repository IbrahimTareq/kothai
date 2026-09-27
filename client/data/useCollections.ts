// The Spaces (collections) list and every mutation the app makes to it.
//
// Lifted out of App.tsx, where its first eight handlers sat among ~30 other pieces
// of unrelated state. They form a closed set: nothing here reads or writes any
// other App state, and the only dependency is the Collections API — so this is
// the whole feature, not a slice of one.
//
// Two write postures, deliberately different:
//   - rename / describe / saveCanvas are optimistic. They are local edits the
//     server cannot disagree with, so the UI moves first and a failed request
//     is swallowed. delete moves first too, then refetches either way: the
//     server lifts the space's sub-spaces up a level, which the client cannot
//     see coming.
//   - create / tag-edit / move / add / remove await the server, because its
//     response reflects work the client cannot predict, or refuses it —
//     smart-rule backfill deciding which notes a tag change pulls in,
//     membership after an add, a move into a loop.
// On failure the second group refetches rather than guessing, which is what
// `refetch` is: the same four-line recovery that used to be written out at
// each of those call sites.
import { useEffect, useState } from 'react'
import { Collections } from './api'
import type { CanvasDoc, Collection } from '../types'

export interface CollectionSource {
  collections: Collection[]
  createCollection: (name: string, tags: string[], parentId?: string) => Promise<Collection>
  renameCollection: (id: string, name: string) => void
  describeCollection: (id: string, description: string) => void
  saveCanvas: (id: string, canvas: CanvasDoc) => void
  editCollectionTags: (id: string, tags: string[]) => Promise<void>
  moveCollection: (id: string, parentId: string | null) => Promise<void>
  deleteCollection: (id: string) => void
  addToCollection: (cid: string, itemId: string) => Promise<void>
  removeFromCollection: (cid: string, itemId: string) => Promise<void>
}

export function useCollections(): CollectionSource {
  const [collections, setCollections] = useState<Collection[]>([])

  const refetch = () => {
    Collections.list()
      .then(setCollections)
      .catch(() => {})
  }
  const sync = (c: Collection) => setCollections(prev => prev.map(x => (x.id === c.id ? c : x)))
  // Await the server and adopt its answer; on failure fall back to the truth.
  const commit = async (run: () => Promise<Collection>) => {
    try {
      sync(await run())
    } catch {
      refetch()
    }
  }

  useEffect(refetch, [])

  return {
    collections,
    createCollection: async (name, tags, parentId) => {
      const c = await Collections.create(name, tags, parentId)
      setCollections(prev => [c, ...prev])
      return c
    },
    renameCollection: (id, name) => {
      setCollections(prev => prev.map(c => (c.id === id ? { ...c, name } : c)))
      Collections.update(id, { name }).catch(() => {})
    },
    describeCollection: (id, description) => {
      setCollections(prev => prev.map(c => (c.id === id ? { ...c, description: description || undefined } : c)))
      Collections.update(id, { description }).catch(() => {})
    },
    // The mounted canvas is the authority for the space it shows; this only
    // keeps the app's copy current so leaving and returning shows the latest
    // board. A failed write refetches, since a stale canvas is a lost layout.
    saveCanvas: (id, canvas) => {
      setCollections(prev => prev.map(c => (c.id === id ? { ...c, canvas } : c)))
      Collections.update(id, { canvas }).catch(refetch)
    },
    editCollectionTags: (id, tags) => commit(() => Collections.update(id, { tags })),
    moveCollection: (id, parentId) => commit(() => Collections.update(id, { parentId })),
    // The server moves a deleted space's sub-spaces up a level
    // (collections.remove), so the list is refetched once it lands rather
    // than guessed at.
    deleteCollection: id => {
      setCollections(prev => prev.filter(c => c.id !== id))
      Collections.remove(id).then(refetch, refetch)
    },
    addToCollection: (cid, itemId) => commit(() => Collections.addItem(cid, itemId)),
    removeFromCollection: (cid, itemId) => commit(() => Collections.removeItem(cid, itemId)),
  }
}
