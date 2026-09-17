import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { RootProvider } from 'fumadocs-ui/provider/next'
import { StaticSearchDialog } from '@/components/search-dialog'
import { Analytics } from '@/components/analytics'
import './global.css'

export const metadata: Metadata = {
  title: { default: 'Kothai', template: '%s | Kothai' },
  description:
    'Save now. Remember later. A local-first archive that reads what you save and answers questions about it.',
  icons: { icon: '/logo.svg' },
  openGraph: {
    type: 'website',
    title: 'Kothai documentation',
    description: 'Save now. Remember later.',
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          crossOrigin=""
          href="/vendor/fonts/Geist-latin.woff2"
        />
      </head>
      <body className="flex min-h-screen flex-col font-sans">
        <RootProvider search={{ SearchDialog: StaticSearchDialog }}>{children}</RootProvider>
        <Analytics />
      </body>
    </html>
  )
}
