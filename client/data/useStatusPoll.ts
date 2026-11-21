// The live model-status poll: is the language model off or still warming, and
// is this a fresh install that has not been set up yet.
//
// Lifted out of App.tsx as a unit. It was already self-contained — one effect,
// four pieces of state nothing else writes — but sitting inline it read as
// four more entries in a thirty-state component rather than as one poll.
//
// The poll never stops. A settings change can flip status back to "loading" at
// any time, so there is no terminal state to stop on; it just slows down once
// everything is ready.
import { useEffect, useState } from 'react'
import { API } from './api'
import { setDemo } from '../components/Demo'

const TICK_LOADING_MS = 1300
const TICK_READY_MS = 4000
const TICK_ERROR_MS = 2200

export interface StatusPoll {
  llmOff: boolean
  llmWarming: string
  // First-run gate: null until the first poll resolves; true shows the model
  // picker (fresh install), false enters the normal app.
  needsSetup: boolean | null
  // Onboarding flips the gate false itself, once first run is saved — which
  // is why this is handed out rather than kept private.
  setNeedsSetup: (v: boolean) => void
}

export function useStatusPoll(): StatusPoll {
  const [llmOff, setLlmOff] = useState(false)
  const [llmWarming, setLlmWarming] = useState('')
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)

  useEffect(() => {
    let stop = false
    const tick = async () => {
      try {
        const s = await API.status()
        // Decided once, from the first successful poll — afterwards Onboarding
        // owns the gate.
        setNeedsSetup(v => (v === null ? !s.configured : v))
        setDemo(s.demo)
        setLlmOff(s.roles.llm.state === 'off')
        // Tied to the llm role specifically, not the aggregate — the aggregate
        // can be "loading" because an unrelated role (e.g. vision) is warming
        // up in the background, which would otherwise show a misleading
        // message under a text answer that isn't waiting on that role at all.
        setLlmWarming(s.roles.llm.state === 'loading' ? s.roles.llm.message || 'Warming up the language model…' : '')
        if (!stop) window.setTimeout(tick, s.aggregate.state === 'loading' ? TICK_LOADING_MS : TICK_READY_MS)
      } catch {
        if (!stop) window.setTimeout(tick, TICK_ERROR_MS)
      }
    }
    tick()
    return () => {
      stop = true
    }
  }, [])

  return { llmOff, llmWarming, needsSetup, setNeedsSetup }
}
