import { defineDocs } from 'fumadocs-mdx/macro'
import { frontmatterSchema } from 'fumadocs-mdx/config'
import { loader, llms } from 'fumadocs-core/source'
import { createElement } from 'react'
import * as icons from 'lucide-react'
import { z } from 'zod'

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // lastModified comes from git log on the original file (see lib/sync.ts),
    // not Fumadocs' built-in flag which would read the gitignored mirror.
    schema: frontmatterSchema.extend({
      lastModified: z.iso.datetime().optional(),
    }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
})

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  icon(name) {
    if (!name) return
    const Icon = (icons as unknown as Record<string, unknown>)[name]
    if (!Icon) throw new Error(`source: no lucide icon named "${name}"`)
    return createElement(Icon as React.ComponentType)
  },
})

export const docsLlms = llms(source, {
  renderPage: async (page) => `# ${page.data.title} (${page.url})

${await page.data.getText('processed')}`,
});
