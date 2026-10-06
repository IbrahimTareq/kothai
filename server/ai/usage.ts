// What each model call cost: one ai_usage row per call attempt, labelled with
// the step that made it (classify, vision, …) and the trigger that set it off
// (a save, an import, a re-tag …), for Settings' usage panel.
//
// The labels ride an AsyncLocalStorage rather than a parameter. A call sits
// several frames below the code that knows why it is happening: a route
// queues a job, the job calls the facade, the facade a provider, the provider
// the wire. Threading a label through each signature would touch two
// providers that sit at their shape caps, for no behaviour of their own.
import { AsyncLocalStorage } from 'node:async_hooks'
import * as store from '../data/usage.ts'
import type { UsageRow } from '../data/usage.ts'

export type Step = 'classify' | 'vision' | 'embed' | 'tag-embed' | 'answer'
export type Trigger =
  | 'save'
  | 'import'
  | 'retag'
  | 'retag-all'
  | 'backlog'
  | 'recovery'
  | 'boot'
  | 'reembed'
  | 'tag-edit'
  | 'ask'
export type UsageCall = Omit<UsageRow, 'at' | 'step' | 'trigger'>

const labels = new AsyncLocalStorage<{ step?: Step; trigger?: Trigger }>()

export function withTrigger<T>(trigger: Trigger, fn: () => T): T {
  return labels.run({ ...labels.getStore(), trigger }, fn)
}

// The outer step wins. tagvocab labels its embeds 'tag-embed' before they
// reach the facade, which would otherwise relabel every one of them 'embed'
// and hide what tag matching costs.
export function withStep<T>(step: Step, fn: () => T): T {
  const outer = labels.getStore()
  return outer?.step ? fn() : labels.run({ ...outer, step }, fn)
}

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000

// Off until the server boots. Tests and scripts run against the real data/
// directory unless told otherwise, and with recording always on, every
// provider test would write rows into the developer's own library database.
let recording = false
let warned = false

export async function startUsageLog(now = Date.now()): Promise<void> {
  await store.pruneUsage(now - RETENTION_MS)
  recording = true
}

export function recordUsage(call: UsageCall): Promise<void> {
  if (!recording) return Promise.resolve()
  const l = labels.getStore()
  return store
    .insertUsage({ at: Date.now(), step: l?.step ?? 'other', trigger: l?.trigger ?? 'other', ...call })
    .catch(e => {
      // The one error swallowed on purpose. Usage is observability, and a lost
      // row must never cost the user an enrichment or an answer. Logged once:
      // a database that refuses one write refuses all of them, and every
      // model call would otherwise repeat the line.
      if (warned) return
      warned = true
      console.error('[usage] could not record a model call:', e instanceof Error ? e.message : e)
    })
}
