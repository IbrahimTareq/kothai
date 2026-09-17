import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

export default withMDX({
  // The repo root, pinned. Without it Turbopack walks up past the checkout,
  // finds a stray lockfile in the home directory and picks a workspace root
  // outside the repository.
  turbopack: { root: new URL('..', import.meta.url).pathname },
  // GitHub Pages serves files, not a Node server, so everything is prerendered.
  // This is what forces search to the static index (see app/api/search) and
  // rules out any request-time work in a page.
  output: 'export',
  // Pages land as out/docs/architecture/index.html. Without this, Next emits
  // links with no trailing slash and Pages 301s every one of them.
  trailingSlash: true,
  // No optimiser without a server; the only raster asset here is the logo.
  images: { unoptimized: true },
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/docs/:slug*.md',
        destination: '/llms.mdx/docs/:slug*/content.md',
      },
    ];
  },
})
