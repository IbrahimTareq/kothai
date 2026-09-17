// Static export has no server, so the search index is emitted as a file at
// build time and the client downloads it (see RootProvider's search config in
// app/layout.tsx). Nine pages, so the index is small enough for that trade —
// revisit if the docs grow an order of magnitude.
import { createFromSource } from 'fumadocs-core/search/server'
import { source } from '@/lib/source'

export const revalidate = false
export const dynamic = 'force-static'

export const { staticGET: GET } = createFromSource(source)
