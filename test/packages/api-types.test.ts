import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Note } from '@kothai/api'
import { API_VERSION } from '@kothai/api'
import type { NoteType } from '../../server/types.ts'

// packages/ cannot import from server/, so Note['type'] is spelled out by hand.
// This fails the typecheck (pnpm build) if the server adds a type and the
// contract does not follow, instead of a client discovering it as a blank card.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const typeMatchesServer: Same<Note['type'], NoteType> = true

test('the v1 contract package resolves and declares version 1', () => {
  assert.equal(API_VERSION, 1)
  assert.equal(typeMatchesServer, true)
})
