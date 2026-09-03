import { defineConfig } from 'vitepress'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { syncDocs } from './sync-docs'

// The markdown lives in /docs at the repo root, not in here. That is deliberate:
// a PR that changes an endpoint changes the doc in the same commit, and the files
// keep rendering on GitHub. This directory only holds the site that wraps them.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const docsDir = join(repoRoot, 'docs')
const srcDir = fileURLToPath(new URL('../src', import.meta.url))
const REPO = 'https://github.com/IbrahimTareq/kothai'
// Project page, so everything is served under /kothai/. A custom domain later
// means changing this one line and adding a CNAME to public/.
const BASE = '/kothai/'
const BLOB = `${REPO}/blob/main/`

// Runs while this config is evaluated, which is before VitePress enumerates
// pages — a plugin hook would be too late.
syncDocs(docsDir, srcDir)

export default defineConfig({
  title: 'Kothai',
  description: 'Save now. Remember later. A local-first archive that reads what you save and answers questions about it.',
  lang: 'en-GB',

  base: BASE,
  srcDir: 'src',

  cleanUrls: true,
  lastUpdated: true,

  // Dead-link checking stays on — it is the thing that catches a doc pointing at
  // a page that was renamed. The only exemption is the local app URL the
  // self-hosting guide tells you to open, which is not reachable from a build.
  ignoreDeadLinks: [/^https?:\/\/localhost/],

  // The docs cross-link into the source tree with paths like ../server/router.js.
  // Those resolve on GitHub but not here, so they are rewritten to blob URLs at
  // render time rather than being edited into absolute links in the markdown.
  markdown: {
    // The docs are written for GitHub, where `{{ ... }}` in inline code is just
    // text. Vue reads it as an interpolation and the build dies on
    // `style={{ padding: 9 }}` and `docker inspect -f '{{.State.OOMKilled}}'`.
    // Fenced blocks already get v-pre from VitePress; inline code does not.
    languageAlias: { caddyfile: 'ini' },

    config(md) {
      const inline = md.renderer.rules.code_inline
      md.renderer.rules.code_inline = (tokens, i, opts, env, self) => {
        const html = inline
          ? inline(tokens, i, opts, env, self)
          : `<code>${md.utils.escapeHtml(tokens[i].content)}</code>`
        return html.replace('<code', '<code v-pre')
      }

      const fallback = md.renderer.rules.link_open
        ?? ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts))

      md.renderer.rules.link_open = (tokens, i, opts, env, self) => {
        const href = tokens[i].attrGet('href')
        if (href?.startsWith('../')) {
          tokens[i].attrSet('href', BLOB + href.replace(/^(\.\.\/)+/, ''))
          tokens[i].attrSet('target', '_blank')
          tokens[i].attrSet('rel', 'noreferrer')
        }
        return fallback(tokens, i, opts, env, self)
      }
    },
  },

  head: [
    ['link', { rel: 'icon', href: `${BASE}logo.png` }],
    ['link', { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: '', href: `${BASE}vendor/fonts/Geist-latin.woff2` }],
    ['meta', { name: 'theme-color', content: '#f7f5f2' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'Kothai documentation' }],
    ['meta', { property: 'og:description', content: 'Save now. Remember later.' }],
  ],

  // Reuse the app's self-hosted Geist and logo instead of committing a second
  // copy of each. vitepress would otherwise look for ../docs/public.
  vite: {
    publicDir: join(repoRoot, 'public'),
    plugins: [
      {
        name: 'kothai-watch-docs',
        configureServer(server) {
          // Edit a file in /docs and the mirror updates, so HMR fires on the
          // real source rather than on the copy.
          server.watcher.add(docsDir)
          server.watcher.on('all', (_event, path) => {
            if (path.startsWith(docsDir)) syncDocs(docsDir, srcDir)
          })
        },
      },
    ],
  },

  // The mirrored files are untracked, so VitePress's own `git log` lookup finds
  // nothing. Ask git about the original instead.
  transformPageData(pageData) {
    try {
      const iso = execFileSync(
        'git',
        ['log', '-1', '--pretty=%ct', '--', join('docs', pageData.relativePath)],
        { cwd: repoRoot, encoding: 'utf8' },
      ).trim()
      if (iso) pageData.lastUpdated = Number(iso) * 1000
    } catch {
      // No git history (a tarball checkout, a brand new page) — the footer just
      // omits the date.
    }
  },

  themeConfig: {
    siteTitle: 'Kothai',

    // One entry, not a partial copy of the sidebar. It lands on the first page
    // of the reading order; the sidebar carries the rest.
    nav: [
      { text: 'Docs', link: '/self-hosting', activeMatch: '^/(?!$)' },
      { text: 'Releases', link: `${REPO}/releases` },
    ],

    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Self-hosting', link: '/self-hosting' },
          { text: 'Development', link: '/development' },
        ],
      },
      {
        text: 'How it works',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'Models & inference', link: '/models' },
          { text: 'Security', link: '/security' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'HTTP API', link: '/api' },
          { text: 'Design system', link: '/design-system' },
        ],
      },
    ],

    // No right-hand outline: the article column gets that width instead. Every
    // page already opens with its own contents list, so nothing is lost.
    aside: false,
    socialLinks: [{ icon: 'github', link: REPO }],

    editLink: {
      pattern: `${REPO}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },

    lastUpdated: { text: 'Last updated' },
    docFooter: { prev: 'Previous', next: 'Next' },
  },
})
