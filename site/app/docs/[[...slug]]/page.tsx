import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { DocsBody, DocsPage, DocsTitle } from 'fumadocs-ui/page'
import { MarkdownCopyButton, ViewOptionsPopover } from 'fumadocs-ui/layouts/docs/page'
import { createRelativeLink } from 'fumadocs-ui/mdx'
import { source } from '@/lib/source'
import { getMDXComponents } from '@/components/mdx'
import { getPageMarkdownUrl } from '@/lib/shared'

// Typed by hand so this file doesn't depend on .next/types being generated first.
type Props = { params: Promise<{ slug?: string[] }> }

export default async function Page(props: Props) {
  const { slug } = await props.params
  const page = source.getPage(slug)
  if (!page) notFound()

  const MDX = page.data.body
  const modified = page.data.lastModified
  const markdownUrl = getPageMarkdownUrl(page).url
  const githubUrl = `https://github.com/IbrahimTareq/kothai/blob/main/docs/${page.slugs.at(-1)}.md`

  return (
    <DocsPage toc={page.data.toc} full={page.data.full} lastUpdate={modified ? new Date(modified) : undefined}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <div className="flex flex-row gap-2 items-center border-b pt-2 pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={githubUrl} />
      </div>
      <DocsBody>
        <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
      </DocsBody>
    </DocsPage>
  )
}

export function generateStaticParams() {
  return source.generateParams()
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { slug } = await props.params
  const page = source.getPage(slug)
  if (!page) notFound()

  return { title: page.data.title, description: page.data.description }
}
