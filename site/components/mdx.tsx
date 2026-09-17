import defaultMdxComponents from 'fumadocs-ui/mdx'
import { Callout } from 'fumadocs-ui/components/callout'
import { Tab, Tabs } from 'fumadocs-ui/components/tabs'
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion'
import { Step, Steps } from 'fumadocs-ui/components/steps'
import { TypeTable } from 'fumadocs-ui/components/type-table'
import type { MDXComponents } from 'mdx/types'
import { Mermaid } from '@/components/mermaid'

// Mermaid is required — lib/sync.ts rewrites ```mermaid fences into <Mermaid />.
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
