// The public demo on the client: whether this is one, what the visitor may
// still do today (see DemoAllowance), and the banner that says so.
//
// A small store rather than a prop or a context: the controls it locks sit
// several views deep in every view, and a provider round App's whole tree only
// to carry one value re-indented all of it. Controls that simply vanish on the
// demo are hidden by :root[data-demo] in shell.css instead, and never read it.
import { useSyncExternalStore } from 'react'
import type { DemoAllowance } from '../types'
import { Button } from '../ui/Button'
import { SettingsGroup, SettingsRow } from './SettingsRow'

const GET_YOUR_OWN = 'https://getkothai.com/'

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
      <a href={GET_YOUR_OWN} target="_blank" rel="noreferrer">
        Get your own
      </a>
    </p>
  )
}

// Settings on the demo. It first said, in one line, that settings were off —
// a sentence alone on a page under the header, which read as a page that had
// failed to load. A visitor who opens Settings is asking what they would get,
// so this answers that in the rows the real page is built from, with no
// control on them: the server refuses every one (server/routes/demo.ts).
const OWN_INSTALL: [string, string][] = [
  ['AI', 'Run the models on your own machine, where nothing leaves it, or connect a service such as OpenRouter.'],
  ['Import', "Bring across what you've already saved on Instagram and TikTok."],
  ['Telegram', 'Save links from your phone by messaging your own bot.'],
  ['Your data', 'Export or back up the whole library, re-tag every note, or erase it all.'],
]

export function DemoSettings() {
  return (
    <div className="settings-body">
      <SettingsGroup label="DEMO">
        <div className="settings-rows">
          <SettingsRow
            title="Settings are off in the demo"
            desc="The library here is shared by every visitor, so the demo lets you save a few links and ask a few questions a day, and change nothing else."
            action={
              <Button asChild tone="solid">
                <a href={GET_YOUR_OWN} target="_blank" rel="noreferrer">
                  Get your own
                </a>
              </Button>
            }
          />
        </div>
      </SettingsGroup>
      <SettingsGroup label="IN YOUR OWN KOTHAI">
        <div className="settings-rows">
          {OWN_INSTALL.map(([title, desc]) => (
            <SettingsRow key={title} title={title} desc={desc} />
          ))}
        </div>
      </SettingsGroup>
    </div>
  )
}
