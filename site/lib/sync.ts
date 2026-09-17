// The markdown lives in /docs at the repo root, not in here. That is deliberate:
// a PR that changes an endpoint changes the doc in the same commit, and the
// files keep rendering on GitHub. This package only holds the site that wraps
// them, so the pages are mirrored into content/docs (gitignored) before Next
// scans them, and /docs stays the only source of truth.
//
// Under VitePress this mirror was also where the home page lived, which meant
// every edit to it was made to a gitignored file and never committed. The home
// page is app/page.tsx now — real source — and nothing but docs comes through
// here.
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

// The sidebar's shape, and the only place it is declared. Each section becomes
// a directory whose meta.json is marked `root`, which is what puts it in the
// dropdown under the search box: Fumadocs derives those tabs from root folders
// in the page tree, and only from those — a flat directory with separators
// gives headings but nothing to switch between.
//
// The cost is that a doc's URL carries its section, so moving a page between
// sections changes its URL. Adding one is two lines here; leaving it out of
// every section is an error rather than a silent fallthrough, so a new doc
// cannot quietly go unfiled.
const SECTIONS = [
  {
    dir: 'getting-started',
    title: 'Getting started',
    description: 'Install it and set it up',
    icon: 'Rocket',
    pages: ['what-is-kothai', 'self-hosting', 'more-ways-to-start', 'configuration', 'development'],
  },
  {
    dir: 'running-it',
    title: 'Running it',
    description: 'Keep it alive and reachable',
    icon: 'ServerCog',
    pages: ['remote-access', 'backups', 'troubleshooting'],
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

// Docs that stay in /docs for contributors but are not published. They read as
// house rules for people changing the code, not as anything a reader of the
// site is looking for. Links to them are pointed at GitHub rather than left to
// 404, which is why this is a list here and not a deletion.
const UNPUBLISHED = new Set(['design-system'])

// Where each doc ends up, derived from the above so the two cannot drift.
type PageEntry = string | { folder: string; title: string; pages: string[] }
function flattenPages(section: string, pages: PageEntry[]): [string, string][] {
  return pages.flatMap(p => {
    if (typeof p === 'string') return [[p, section]] as [string, string][]
    // Folder index and children all go in the subfolder
    return [[p.folder, `${section}/${p.folder}`], ...p.pages.map(sub => [sub, `${section}/${p.folder}`])] as [string, string][]
  })
}
const SECTION_OF = new Map(SECTIONS.flatMap(s => flattenPages(s.dir, s.pages as PageEntry[])))

// The logo and the two font faces are the app's, referenced from the nav, the
// favicon and the @font-face rules. A second committed copy of a woff2 is a copy
// that goes stale silently, so they are mirrored in rather than duplicated.
// This list is the whole contract: if the site starts using another app asset,
// it goes here.
const SHARED = ['logo.svg', 'vendor/fonts/Geist-latin.woff2', 'vendor/fonts/GeistMono-latin.woff2']

// GitHub's five alert kinds onto the four Fumadocs Callout types that carry the
// same weight. IMPORTANT and WARNING both land on `warn` because Fumadocs draws
// no tone between them.
const ALERTS: Record<string, string> = {
  NOTE: 'info',
  TIP: 'idea',
  IMPORTANT: 'warn',
  WARNING: 'warn',
  CAUTION: 'error',
}

function lastModified(name: string): string | undefined {
  try {
    // The mirrored file is untracked, so git knows nothing about it. Ask about
    // the original instead.
    const ts = execFileSync('git', ['log', '-1', '--pretty=%ct', '--', join('docs', name)], {
      cwd: join(repoRoot, '..'),
      encoding: 'utf8',
    }).trim()
    return ts ? new Date(Number(ts) * 1000).toISOString() : undefined
  } catch {
    // No git history (a tarball checkout, a brand new page) — the footer just
    // omits the date.
    return undefined
  }
}

function toMdx(source: string, name: string, linked: Set<string>): string {
  let body = source

  // Fumadocs renders the title from frontmatter, so the H1 would otherwise be
  // printed twice.
  const h1 = body.match(/^#\s+(.+)$/m)
  const title = h1 ? h1[1].trim() : name.replace(/\.md$/, '')
  if (h1) body = body.replace(h1[0], '').replace(/^\s+/, '')

  // First real paragraph, flattened. Feeds both the page subtitle and the
  // <meta name="description">. Skip headings, blockquotes, tables, code blocks,
  // and JSX component blocks (like <TypeTable>).
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

  // `<http://localhost:5173>` is a GitHub autolink and valid markdown, but MDX
  // reads the angle bracket as the start of a JSX tag and the build dies. The
  // bare URL still autolinks under GFM, so this costs nothing on GitHub.
  body = body.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')

  // Shiki throws on a language it does not know, which fails the whole build
  // rather than dropping the highlighting. VitePress aliased caddyfile to ini
  // for exactly this.
  body = body.replace(/^```caddyfile$/gm, '```ini')

  // Mermaid is a renderer, not a grammar, so the fences become a component
  // here. It has to happen before the MDX pipeline: rehype-code tokenises the
  // block and drops its language class, so a `pre` override downstream has
  // nothing left to recognise. These four diagrams never drew under VitePress
  // for the same reason.
  body = body.replace(
    /^```mermaid\n([\s\S]*?)\n```$/gm,
    (_m, chart) => `<Mermaid chart={${JSON.stringify(chart)}} />`,
  )

  // GitHub alert blockquotes. VitePress rendered these natively; Fumadocs has
  // Callout instead, and without this the `[!TIP]` marker prints as text. The
  // map is lossy in one direction only — GitHub has no equivalent of `idea`,
  // so nothing round-trips wrong.
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

  // The docs link each other as `security.md#the-password-gate`, which is what
  // GitHub needs. Fumadocs' createRelativeLink only rewrites some of those, so
  // they are resolved here where the mapping is known and total.
  body = body.replace(/\]\(([a-z0-9-]+)\.md(#[^)]*)?\)/gi, (_m, target: string, anchor?: string) => {
    linked.add(target)
    if (UNPUBLISHED.has(target)) return `](${BLOB}docs/${target}.md${anchor ?? ''})`
    // An unknown target is left to the dead-link check below rather than
    // guessed at, so the error names the doc instead of a 404 doing it later.
    const dir = SECTION_OF.get(target)
    return dir ? `](/docs/${dir}/${target}/${anchor ?? ''})` : `](/docs/${target}/${anchor ?? ''})`
  })

  // The docs cross-link into the source tree with paths like ../server/router.ts.
  // Those resolve on GitHub but not here, so they are pointed at blob URLs
  // rather than being edited into absolute links in the markdown.
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
  // Rebuilt wholesale rather than reconciled: the mirror is gitignored and
  // cheap to write, and a stale file surviving a rename is exactly the failure
  // the old incremental copy kept producing.
  rmSync(contentDir, { recursive: true, force: true })
  mkdirSync(contentDir, { recursive: true })

  // index.md was the VitePress home page's frontmatter, which has no meaning as
  // a doc. The home page is a React page now.
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

  // VitePress failed the build on a dead internal link, and that is what caught
  // a doc still pointing at a page someone renamed. Next has no equivalent, so
  // the check lives here — where the rewriting happens and the full set of
  // pages is already known. Only cross-doc links are covered; anchors and
  // external URLs are not, but a rename is the failure this existed for.
  const dead = [...linked].flatMap(([from, targets]) =>
    [...targets].filter(t => !present.has(t) && !UNPUBLISHED.has(t)).map(t => `  ${from} -> ${t}.md`),
  )
  if (dead.length > 0) {
    throw new Error(`sync: ${dead.length} link(s) point at a doc that does not exist:\n${dead.join('\n')}`)
  }

  // `root: true` is the whole point of the folders — it is what Fumadocs looks
  // for when building the section dropdown.
  for (const section of SECTIONS) {
    const sectionPages = (section.pages as PageEntry[]).flatMap(p => {
      if (typeof p === 'string') return present.has(p) ? [p] : []
      // For folder entries, include the folder name if the index page exists
      if (!present.has(p.folder)) return []
      // Rename the folder index file from slug.mdx to index.mdx
      const slugPath = join(contentDir, section.dir, p.folder, `${p.folder}.mdx`)
      const indexPath = join(contentDir, section.dir, p.folder, 'index.mdx')
      if (existsSync(slugPath)) {
        const content = readFileSync(slugPath, 'utf8')
        writeFileSync(indexPath, content)
        rmSync(slugPath)
      }
      // Create subfolder meta.json - don't include 'index' as it's the folder's landing page
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
