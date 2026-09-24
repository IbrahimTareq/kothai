// The public demo on the client: whether this is one, what the visitor may
// still do today (see DemoAllowance), and the banner that says so.
//
// A small store rather than a prop or a context: the controls it locks sit
// several views deep in every view, and a provider round App's whole tree only
// to carry one value re-indented all of it. Controls that simply vanish on the
// demo are hidden by :root[data-demo] in shell.css instead, and never read it.
import { useSyncExternalStore } from 'react'
import type { DemoAllowance } from '../types'

let current: DemoAllowance | null = null
const listeners = new Set<() => void>()

// Called with every status poll. An unchanged allowance is dropped, or every
// control reading it would re-render every few seconds for nothing.
export function setDemo(next: DemoAllowance | null) {
  if (current?.savesLeft === next?.savesLeft && current?.asksLeft === next?.asksLeft) return
  current = next
  // On the root, not on .app: the item view and capture render in portals
  // outside it, and shell.css hides their write controls by this.
  document.documentElement.toggleAttribute('data-demo', !!next)
  for (const l of listeners) l()
}

export const useDemo = () =>
  useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

// The one line every visitor sees. What the demo refuses is locked or left out
// where it sits, and Settings says why; "everything else is read-only" here
// wrapped to three lines on a phone and lost the first.
export function DemoBanner() {
  const demo = useDemo()
  if (!demo) return null
  return (
    <p className="demo-banner">
      <span>
        Demo · {count(demo.savesLeft, 'link')} and {count(demo.asksLeft, 'question')} left today
      </span>
      <a href="https://getkothai.com/" target="_blank" rel="noreferrer">
        Get your own
      </a>
    </p>
  )
}
