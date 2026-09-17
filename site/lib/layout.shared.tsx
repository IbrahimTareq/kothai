import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { REPO } from './constants'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" aria-hidden className="h-5 w-auto dark:hidden" />
          <img src="/logo-dark.svg" alt="" aria-hidden className="hidden h-5 w-auto dark:block" />
          <span className="sr-only">Kothai</span>
        </>
      ),
      url: '/',
    },
    githubUrl: REPO,
  }
}
