import { defineDocs } from 'fumadocs-mdx/macro'
import { frontmatterSchema } from 'fumadocs-mdx/config'
import { loader, llms } from 'fumadocs-core/source'
import { createElement } from 'react'
import * as icons from 'lucide-react'
import { z } from 'zod'

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // lastModified is written into the mirrored frontmatter by lib/sync.ts,
    // from `git log` on the *original* file under /docs. Fumadocs' own
    // lastModified flag reads the mirror, which is gitignored and therefore has
    // no history at all.
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
  // Section icons come through meta.json as plain names, which is all JSON can
  // carry. An unknown name is an error rather than a blank space: the names are
  // written in lib/sync.ts, so a miss is a typo, and a typo that renders as
  // nothing is one nobody notices.
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
