// Client entry — mounts the React app and pulls in the global stylesheet.
import { createRoot } from 'react-dom/client'
import { lazy, Suspense } from 'react'
import App from './App'
import '../styles/index.css'

// /ui is the primitives playground (views/Playground.tsx), and only in
// development: import.meta.env.DEV is false in the production build, so this
// branch and the chunk it would load are dropped from what ships.
const Playground =
  import.meta.env.DEV && location.pathname === '/ui'
    ? lazy(() => import('../views/Playground').then(m => ({ default: m.Playground })))
    : null

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    Playground ? (
      <Suspense>
        <Playground />
      </Suspense>
    ) : (
      <App />
    ),
  )
