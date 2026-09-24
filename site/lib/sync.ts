// Mirrors markdown from /docs at the repo root into content/docs (gitignored)
// so Fumadocs can process them. /docs stays the single source of truth — a PR
// that changes an endpoint changes the doc in the same commit.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO } from './constants.ts'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const docsDir = join(repoRoot, '..', 'docs')
const contentDir = join(repoRoot, 'content', 'docs')
const appPublic = join(repoRoot, '..', 'public')
const sitePublic = join(repoRoot, 'public')

const BLOB = `${REPO}/blob/main/`

// Each section becomes a root folder in Fumadocs' page tree, which drives the
// dropdown. Leaving a doc out of every section is an error, not a silent miss.
const SECTIONS = [
  {
    dir: 'getting-started',
    title: 'Getting started',
    description: 'Install it and set it up',
    icon: 'Rocket',
    pages: ['what-is-kothai', 'self-hosting', 'configuration'],
  },
  {
    dir: 'running-it',
    title: 'Running it',
    description: 'Keep it alive and reachable',
    icon: 'ServerCog',
    pages: ['remote-access', 'telegram', 'backups', 'troubleshooting'],
  },
  {
    dir: 'how-it-works',
    title: 'How it works',
    description: 'The design and its limits',
    icon: 'Blocks',
    pages: ['architecture', 'models', 'security'],
  },
  {
    dir: 'reference',
    title: 'API Reference',
    description: 'The HTTP surface',
    icon: 'BookText',
    pages: [
      'reference',
      { folder: 'api', title: 'HTTP API', pages: ['api-auth', 'api-notes', 'api-ask', 'api-chats', 'api-spaces', 'api-settings', 'api-backup', 'api-import'] },
    ],
  },
]

// Docs kept in /docs for contributors but not published on the site.
// Links to them are pointed at GitHub instead of left to 404.
const UNPUBLISHED = new Set(['design-system', 'development'])

type PageEntry = string | { folder: string; title: string; pages: string[] }
function flattenPages(section: string, pages: PageEntry[]): [string, string][] {
  return pages.flatMap(p => {
    if (typeof p === 'string') return [[p, section]] as [string, string][]
    return [[p.folder, `${section}/${p.folder}`], ...p.pages.map(sub => [sub, `${section}/${p.folder}`])] as [string, string][]
  })
}
const SECTION_OF = new Map(SECTIONS.flatMap(s => flattenPages(s.dir, s.pages as PageEntry[])))

// Mirrored from the app's public/ so the site shares fonts and logo
// without a second committed copy that goes stale.
const SHARED = ['logo.svg', 'vendor/fonts/Geist-latin.woff2', 'vendor/fonts/GeistMono-latin.woff2']

// GitHub alert kinds → Fumadocs Callout types.
// IMPORTANT and WARNING both land on `warn` (Fumadocs draws no distinction).
const ALERTS: Record<string, string> = {
  NOTE: 'info',
  TIP: 'idea',
  IMPORTANT: 'warn',
  WARNING: 'warn',
  CAUTION: 'error',
}

function lastModified(name: string): string | undefined {
  try {
    // Ask git about the original in /docs, not the mirrored (untracked) copy.
    const ts = execFileSync('git', ['log', '-1', '--pretty=%ct', '--', join('docs', name)], {
      cwd: join(repoRoot, '..'),
      encoding: 'utf8',
    }).trim()
    return ts ? new Date(Number(ts) * 1000).toISOString() : undefined
  } catch {
    return undefined
  }
}

function toMdx(source: string, name: string, linked: Set<string>): string {
  let body = source

  // Fumadocs renders the title from frontmatter, so strip the H1.
  const h1 = body.match(/^#\s+(.+)$/m)
  const title = h1 ? h1[1].trim() : name.replace(/\.md$/, '')
  if (h1) body = body.replace(h1[0], '').replace(/^\s+/, '')

  // First real paragraph for <meta description>. Skip headings, blockquotes,
  // tables, code blocks, and JSX components.
  const lead = body
    .split(/\n\s*\n/)
    .find(p => p.trim() && !p.startsWith('#') && !p.startsWith('>') && !p.startsWith('|') && !p.startsWith('```') && !p.startsWith('<'))
  const description = lead
    ? lead
        .replace(/\s+/g, ' ')
        .replace(/[`*_]/g, '')
        .trim()
        .slice(0, 180)
    : ''

  // MDX reads `<http://...>` as JSX. Strip angle brackets (bare URL still autolinks).
  body = body.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')

  // Shiki throws on unknown languages. Alias caddyfile → ini.
  body = body.replace(/^```caddyfile$/gm, '```ini')

  // Mermaid fences → component. Must happen before MDX pipeline strips the language class.
  body = body.replace(
    /^```mermaid\n([\s\S]*?)\n```$/gm,
    (_m, chart) => `<Mermaid chart={${JSON.stringify(chart)}} />`,
  )

  // GitHub alert blockquotes → Fumadocs Callout components.
  body = body.replace(
    /^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\n((?:>.*(?:\n|$))*)/gm,
    (_m, kind: string, rest: string) => {
      const inner = rest
        .split('\n')
        .map(line => line.replace(/^>\s?/, ''))
        .join('\n')
        .trim()
      return `<Callout type="${ALERTS[kind]}">\n${inner}\n</Callout>\n`
    },
  )

  // Resolve cross-doc links (security.md#section → /docs/how-it-works/security/#section).
  body = body.replace(/\]\(([a-z0-9-]+)\.md(#[^)]*)?\)/gi, (_m, target: string, anchor?: string) => {
    linked.add(target)
    if (UNPUBLISHED.has(target)) return `](${BLOB}docs/${target}.md${anchor ?? ''})`
    const dir = SECTION_OF.get(target)
    return dir ? `](/docs/${dir}/${target}/${anchor ?? ''})` : `](/docs/${target}/${anchor ?? ''})`
  })

  // Resolve relative source-tree links (../server/router.ts → GitHub blob URL).
  body = body.replace(/\]\((\.\.\/)+([^)]+)\)/g, (_m, _dots, path) => `](${BLOB}${path})`)

  const modified = lastModified(name)
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    description ? `description: ${JSON.stringify(description)}` : '',
    modified ? `lastModified: ${modified}` : '',
    '---',
    '',
  ]
    .filter(Boolean)
    .join('\n')

  return `${frontmatter}\n${body}`
}

function syncDocs(): void {
  rmSync(contentDir, { recursive: true, force: true })
  mkdirSync(contentDir, { recursive: true })

  const all = readdirSync(docsDir).filter(
    name => name.endsWith('.md') && name !== 'index.md' && statSync(join(docsDir, name)).isFile(),
  )
  const wanted = all.filter(name => !UNPUBLISHED.has(name.replace(/\.md$/, '')))

  const unfiled = wanted
    .map(n => n.replace(/\.md$/, ''))
    .filter(name => !SECTION_OF.has(name) && !UNPUBLISHED.has(name))
  if (unfiled.length > 0) {
    throw new Error(
      `sync: ${unfiled.join(', ')} ${unfiled.length === 1 ? 'is' : 'are'} not in any section of SECTIONS. ` +
        'Add it to one — an unfiled doc has no place in the sidebar and no URL.',
    )
  }

  const present = new Set(wanted.map(n => n.replace(/\.md$/, '')))
  const linked = new Map<string, Set<string>>()

  for (const name of wanted) {
    const slug = name.replace(/\.md$/, '')
    const dir = join(contentDir, SECTION_OF.get(slug) as string)
    mkdirSync(dir, { recursive: true })

    const targets = new Set<string>()
    writeFileSync(join(dir, `${slug}.mdx`), toMdx(readFileSync(join(docsDir, name), 'utf8'), name, targets))
    linked.set(name, targets)
  }

  // Fail on dead cross-doc links so a renamed page is caught before deploy.
  const dead = [...linked].flatMap(([from, targets]) =>
    [...targets].filter(t => !present.has(t) && !UNPUBLISHED.has(t)).map(t => `  ${from} -> ${t}.md`),
  )
  if (dead.length > 0) {
    throw new Error(`sync: ${dead.length} link(s) point at a doc that does not exist:\n${dead.join('\n')}`)
  }

  // Generate meta.json files. `root: true` is what Fumadocs uses for the section dropdown.
  for (const section of SECTIONS) {
    const sectionPages = (section.pages as PageEntry[]).flatMap(p => {
      if (typeof p === 'string') return present.has(p) ? [p] : []
      if (!present.has(p.folder)) return []
      // Rename folder index from slug.mdx to index.mdx
      const slugPath = join(contentDir, section.dir, p.folder, `${p.folder}.mdx`)
      const indexPath = join(contentDir, section.dir, p.folder, 'index.mdx')
      if (existsSync(slugPath)) {
        const content = readFileSync(slugPath, 'utf8')
        writeFileSync(indexPath, content)
        rmSync(slugPath)
      }
      const subPages = p.pages.filter(sub => present.has(sub))
      writeFileSync(
        join(contentDir, section.dir, p.folder, 'meta.json'),
        `${JSON.stringify({ title: p.title, pages: subPages }, null, 2)}\n`,
      )
      return [p.folder]
    })
    if (sectionPages.length === 0) continue

    writeFileSync(
      join(contentDir, section.dir, 'meta.json'),
      `${JSON.stringify({ root: true, title: section.title, description: section.description, icon: section.icon, pages: sectionPages }, null, 2)}\n`,
    )
  }

  writeFileSync(
    join(contentDir, 'meta.json'),
    `${JSON.stringify({ pages: SECTIONS.map(s => s.dir) }, null, 2)}\n`,
  )
}

function syncAssets(): void {
  for (const name of SHARED) {
    const src = join(appPublic, name)
    const dest = join(sitePublic, name)
    if (!existsSync(src)) throw new Error(`sync: ${name} is missing from ${appPublic}`)
    mkdirSync(dirname(dest), { recursive: true })
    if (existsSync(dest) && statSync(dest).mtimeMs >= statSync(src).mtimeMs) continue
    cpSync(src, dest)
  }
}

syncDocs()
syncAssets()
