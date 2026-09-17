import Script from 'next/script'

// Opt-in via env vars. Forks don't inherit analytics — set your own:
//   NEXT_PUBLIC_UMAMI_WEBSITE_ID
//   NEXT_PUBLIC_UMAMI_URL
export function Analytics() {
  const websiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID
  const scriptUrl = process.env.NEXT_PUBLIC_UMAMI_URL

  if (!websiteId || !scriptUrl) return null

  return (
    <Script
      src={scriptUrl}
      data-website-id={websiteId}
      strategy="afterInteractive"
    />
  )
}
