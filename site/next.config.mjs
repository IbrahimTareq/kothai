import { createMDX } from 'fumadocs-mdx/next'

const withMDX = createMDX()

export default withMDX({
  // Pin repo root so Turbopack doesn't walk past the checkout.
  turbopack: { root: new URL('..', import.meta.url).pathname },
  output: 'export',
  trailingSlash: true,
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
