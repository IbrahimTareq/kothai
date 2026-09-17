'use client'

import Link from 'next/link'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { ArrowRight, Moon, Play, Sun } from 'lucide-react'
import { GithubMark } from '@/components/github-mark'
import { Cloudscape } from '@/components/cloudscape'
import { REPO } from '@/lib/constants'

// Two skies. The night set is picked so the dark palette's near-white ink clears
// 6.8:1 against the lightest cloud band, which is the worst case — the base is
// darker still. Do not lighten colorTop without re-checking that.
const DAY_SKY = { colorBottom: '#87ceeb', colorMid: '#f8f8f8', colorTop: '#ffffff' }
const NIGHT_SKY = { colorBottom: '#0a1626', colorMid: '#16304f', colorTop: '#2b5580' }

// White ground behind a slate hairline, and the ground stays white in both
// appearances — which is why the label is a literal ink rather than a theme
// token that inverts while the button underneath it does not. Hover barely moves
// the ground: a near-white grey, not the blue, which on a blue sky would read as
// a second accent instead of as a state.
const BUTTON =
  'inline-flex items-center gap-2 rounded-lg border bg-white px-4 py-2 text-sm font-semibold ' +
  'text-[#292827] transition-colors duration-200'
const LIVE = `${BUTTON} border-slate-300 hover:border-slate-500 hover:bg-slate-100 active:bg-slate-200`

export function Hero() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  // The server render has no theme, so anything keyed off it has to wait for the
  // client or the markup mismatches on hydration.
  useEffect(() => setMounted(true), [])
  const dark = mounted && resolvedTheme === 'dark'

  return (
    <main className="relative isolate flex min-h-screen flex-col items-center justify-center overflow-hidden px-6">
      <Cloudscape {...(dark ? NIGHT_SKY : DAY_SKY)} className="absolute inset-0 -z-10" />

      {/* eslint-disable @next/next/no-img-element */}
      <img
        src={dark ? '/logo-dark.svg' : '/logo.svg'}
        alt="Kothai"
        className="w-[min(520px,76vw)] transition-opacity duration-600"
      />
      {/* eslint-enable @next/next/no-img-element */}

      <h1 className="mt-2 max-w-[28ch] text-center text-xl tracking-tight text-[#292827] transition-colors duration-600 sm:text-2xl dark:text-[#f2f0ed]">
        Save now. Remember later.
      </h1>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link href="/docs/getting-started/what-is-kothai" className={LIVE}>
          <ArrowRight className="size-4" />
          Get started
        </Link>

        {/* No href, so this is inert and out of the tab order — which is what
            disabled has to mean. Give it a link when the demo is real. */}
        <span className={`${BUTTON} cursor-not-allowed border-slate-200 text-[#292827]/40`} aria-disabled>
          <Play className="size-4" />
          Live Demo
          <span className="rounded-full bg-[#292827]/7 px-1.5 py-0.5 text-xs">Soon</span>
        </span>

        <a href={REPO} target="_blank" rel="noreferrer" className={LIVE}>
          <GithubMark className="size-4" />
          GitHub
        </a>
      </div>

      <button
        type="button"
        onClick={() => setTheme(dark ? 'light' : 'dark')}
        aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
        className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full border border-slate-300 bg-white p-2 text-[#292827] transition-colors hover:bg-slate-100"
      >
        {dark ? <Moon className="size-4" /> : <Sun className="size-4" />}
      </button>
    </main>
  )
}
