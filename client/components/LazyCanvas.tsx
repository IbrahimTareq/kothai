// The Space canvas, loaded on first use. React Flow is about a third of the
// client bundle and most visits never open a canvas: splitting it out takes
// the page from 167 KB to 103 KB gzipped.
import { lazy, Suspense, type ComponentProps } from 'react'
import { Icon } from './icons'

const Canvas = lazy(() => import('./Canvas').then(m => ({ default: m.Canvas })))

export function CanvasLoading() {
  return (
    <div className="empty">
      <Icon name="spark" size={40} />
      <p>Loading canvas…</p>
    </div>
  )
}

export function LazyCanvas(props: ComponentProps<typeof Canvas>) {
  return (
    <Suspense fallback={<CanvasLoading />}>
      <Canvas {...props} />
    </Suspense>
  )
}
