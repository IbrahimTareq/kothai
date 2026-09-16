// A complete ServerNote, so a test can name only the fields it is about.
//
// Thirteen test files mock store.allNotes() with an array of note literals.
// In .js those arrays are inferred as any[] and every read off them is
// unchecked; typing one as ServerNote[] is what makes the reads mean
// something, and that in turn requires every literal to carry all ten required
// fields — which is a lot of noise around the one or two a test is actually
// asserting on.
//
// Defaults are the emptiest legal note rather than realistic sample data: a
// test that depends on a value it did not set should fail, not quietly pass on
// a fixture's opinion.
import type { ServerNote } from '../../server/types.ts'

export function note(partial: Partial<ServerNote> = {}): ServerNote {
  return {
    id: 'note-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    type: 'text',
    category: '',
    title: '',
    summary: '',
    tags: [],
    content: '',
    url: null,
    image: null,
    ...partial,
  }
}
