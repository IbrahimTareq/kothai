import defaultMdxComponents from 'fumadocs-ui/mdx'
import { Callout } from 'fumadocs-ui/components/callout'
import { Tab, Tabs } from 'fumadocs-ui/components/tabs'
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion'
import { Step, Steps } from 'fumadocs-ui/components/steps'
import { TypeTable } from 'fumadocs-ui/components/type-table'
import type { MDXComponents } from 'mdx/types'
import { Mermaid } from '@/components/mermaid'

// Everything a doc can reach for. The defaults already give code blocks their
// copy button and headings their anchors; the rest are the components the docs
// are free to use now that the pages are MDX rather than plain markdown.
//
// Mermaid is not optional here — lib/sync.ts rewrites every ```mermaid fence
// into <Mermaid />, so a page with a diagram will not compile without it.
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Mermaid,
    Callout,
    Tabs,
    Tab,
    Accordions,
    Accordion,
    Steps,
    Step,
    TypeTable,
    ...components,
  }
}
