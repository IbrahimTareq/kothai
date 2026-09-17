'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useTheme } from 'next-themes'

// Lazy-imported because the library is large and only one page uses it.
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, '')
  const { resolvedTheme } = useTheme()
  const [svg, setSvg] = useState('')
  const host = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const { default: mermaid } = await import('mermaid')
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: resolvedTheme === 'dark' ? 'dark' : 'default',
        fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif',
      })
      try {
        const { svg } = await mermaid.render(`m${id}`, chart)
        if (!cancelled) setSvg(svg)
      } catch {
        if (!cancelled) setSvg('')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [chart, id, resolvedTheme])

  if (!svg) return <pre className="overflow-x-auto text-xs opacity-60">{chart}</pre>
  // eslint-disable-next-line react/no-danger
  return <div ref={host} className="my-6 flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} />
}
