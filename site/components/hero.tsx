'use client'

import Link from 'next/link'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { ArrowRight, Moon, Play, Sun } from 'lucide-react'
import { GithubMark } from '@/components/github-mark'
import { Cloudscape } from '@/components/cloudscape'
import { REPO } from '@/lib/constants'

// Do not lighten colorTop without rechecking contrast (currently 6.8:1).
const DAY_SKY = { colorBottom: '#87ceeb', colorMid: '#f8f8f8', colorTop: '#ffffff' }
const NIGHT_SKY = { colorBottom: '#0a1626', colorMid: '#16304f', colorTop: '#2b5580' }

const BUTTON =
  'inline-flex items-center gap-2 rounded-lg border bg-white px-4 py-2 text-sm font-semibold ' +
  'text-[#292827] transition-colors duration-200'
const LIVE = `${BUTTON} border-slate-300 hover:border-slate-500 hover:bg-slate-100 active:bg-slate-200`

export function Hero() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  // Wait for client to avoid hydration mismatch on theme-dependent elements.
  useEffect(() => setMounted(true), [])
  const dark = mounted && resolvedTheme === 'dark'

  return (
    <main className="relative isolate flex h-screen max-h-screen flex-col items-center justify-center overflow-hidden px-4 py-8 sm:px-6">
      <Cloudscape {...(dark ? NIGHT_SKY : DAY_SKY)} className="absolute inset-0 -z-10" />

      {/* eslint-disable @next/next/no-img-element */}
      <img
        src={dark ? '/logo-dark.svg' : '/logo.svg'}
        alt="Kothai"
        className="w-[min(520px,70vw)] max-h-[30vh] object-contain transition-opacity duration-600"
      />
      {/* eslint-enable @next/next/no-img-element */}

      <h1 className="mt-2 max-w-[28ch] text-center text-lg tracking-tight text-[#292827] transition-colors duration-600 sm:text-2xl dark:text-[#f2f0ed]">
        Save now. Remember later.
      </h1>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2 sm:mt-8 sm:gap-3">
        <Link href="/docs/getting-started/what-is-kothai" className={LIVE}>
          <ArrowRight className="size-4" />
          Get started
        </Link>

        <span className={`${BUTTON} hidden cursor-not-allowed border-slate-200 text-[#292827]/40 sm:inline-flex`} aria-disabled>
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
        className="mt-6 rounded-full border border-slate-300 bg-white p-2 text-[#292827] transition-colors hover:bg-slate-100 sm:absolute sm:bottom-8 sm:left-1/2 sm:mt-0 sm:-translate-x-1/2"
      >
        {dark ? <Moon className="size-4" /> : <Sun className="size-4" />}
      </button>
    </main>
  )
}
