// Tests for the Instagram queue's lowest-priority lane: availability checks.
//
// A daily sweep queues ~240 embed fetches at ~2.7s each. A new save queued
// behind them would wait ~11 minutes for its caption and thumbnail, so checks
// must always yield to the fetches a user is waiting on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { _igQueueState, queueIgMeta, queueIgEmbed } from '../../../server/links/instagram-queue.ts'

const post = (id: string) => `https://www.instagram.com/p/${id}/`

test('a new save goes ahead of queued availability checks', () => {
  const s = _igQueueState
  s.pause()
  // Never settled: the queue is paused and cleared below. Only the order matters.
  queueIgEmbed(post('c1'))
  queueIgEmbed(post('c2'))
  queueIgMeta('m1', post('m1'))
  queueIgMeta('m2', post('m2'))
  assert.deepEqual(s.ids(), ['m1', 'm2', post('c1'), post('c2')])
  s.clear()
})

test('with no checks queued, saves keep their arrival order', () => {
  const s = _igQueueState
  s.pause()
  queueIgMeta('a', post('a'))
  queueIgMeta('b', post('b'))
  assert.deepEqual(s.ids(), ['a', 'b'])
  s.clear()
})
