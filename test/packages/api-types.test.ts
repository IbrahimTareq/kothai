import assert from 'node:assert/strict'
import { test } from 'node:test'
import { API_VERSION } from '@kothai/api'

test('the v1 contract package resolves and declares version 1', () => {
  assert.equal(API_VERSION, 1)
})
