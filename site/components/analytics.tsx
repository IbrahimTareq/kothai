import Script from 'next/script'

// Umami analytics, opt-in via environment variables. Forks don't inherit the
// original project's analytics - they'd need to set up their own Umami instance
// and configure these variables in their deployment.
//
// Set these in your deployment environment (Vercel, Netlify, etc.):
//   NEXT_PUBLIC_UMAMI_WEBSITE_ID - your Umami website ID
//   NEXT_PUBLIC_UMAMI_URL - URL to your Umami script (e.g. https://analytics.example.com/script.js)
export function Analytics() {
  const websiteId = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID
  const scriptUrl = process.env.NEXT_PUBLIC_UMAMI_URL

  // No env vars = no analytics. Forks start with a clean slate.
  if (!websiteId || !scriptUrl) return null

  return (
    <Script
      src={scriptUrl}
      data-website-id={websiteId}
      strategy="afterInteractive"
    />
  )
}
