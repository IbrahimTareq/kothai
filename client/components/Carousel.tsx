// Carousel.tsx — swipeable card deck for a multi-image item (an Instagram
// carousel today). Neighbouring slides peek out from behind the active one so
// the deck reads the way the post itself does — a stack you push through,
// rather than a filmstrip that happens to be cropped.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { PEEK, SLOP_PX, slideAt, nextIndex } from '../layout/carousel'

interface CarouselProps {
  slides: string[]
  alt?: string
  onOpen?: () => void   // a tap that wasn't a drag — opens the source post
  badge?: ReactNode     // brand chip pinned to the active slide
}

export function Carousel({ slides, alt, onOpen, badge }: CarouselProps) {
  const [i, setI] = useState(0)
  const [drag, setDrag] = useState(0)
  // Instagram carousels are 4:5, 1:1 or 1.91:1 depending on the post, so the
  // stage takes its shape from the first slide rather than cropping everything
  // to one guess. 4:5 until that image reports its size.
  const [ratio, setRatio] = useState(0.8)
  // Slides whose image has decoded. A sidecar's later slides are still being
  // pulled over the network when the deck first renders, so an undecoded one
  // is a black rectangle with no explanation — it gets the skeleton sheen
  // (.carousel-slide.loading) until its image is actually there.
  const [loaded, setLoaded] = useState<Record<string, boolean>>({})
  const stage = useRef<HTMLDivElement>(null)
  const startX = useRef<number | null>(null)
  const dragged = useRef(false)

  useEffect(() => { setI(0); setDrag(0); setLoaded({}) }, [slides.join('|')])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setI((v) => Math.min(slides.length - 1, v + 1))
      if (e.key === 'ArrowLeft') setI((v) => Math.max(0, v - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [slides.length])

  const width = () => stage.current?.clientWidth || 1
  const onDown = (e: React.PointerEvent) => {
    startX.current = e.clientX
    dragged.current = false
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (startX.current === null) return
    const dx = e.clientX - startX.current
    if (Math.abs(dx) > SLOP_PX) dragged.current = true
    setDrag(dx)
  }
  const onUp = (e: React.PointerEvent) => {
    if (startX.current === null) return
    const dx = e.clientX - startX.current
    startX.current = null
    setDrag(0)
    if (!dragged.current) return onOpen?.()
    setI((v) => nextIndex(v, dx, slides.length))
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const dragFrac = drag / width()

  return (
    <div className="carousel">
      <div
        className={'carousel-stage' + (drag ? ' dragging' : '')}
        ref={stage}
        style={{ aspectRatio: String(ratio) }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {slides.map((src, idx) => {
          const dist = idx - i - dragFrac
          if (Math.abs(dist) > PEEK + 1) return null
          const { x, scale, opacity, z } = slideAt(dist)
          return (
            <div
              key={src}
              className={'carousel-slide' + (idx === i ? ' active' : '') + (loaded[src] ? '' : ' loading')}
              style={{ transform: `translateX(${x}%) scale(${scale})`, opacity, zIndex: z }}
            >
              <img
                src={src}
                alt={alt || ''}
                draggable={false}
                loading={Math.abs(idx - i) <= 1 ? 'eager' : 'lazy'}
                onLoad={(e) => {
                  setLoaded((m) => (m[src] ? m : { ...m, [src]: true }))
                  if (idx !== 0) return
                  const el = e.currentTarget
                  if (el.naturalWidth && el.naturalHeight) {
                    setRatio(Math.max(0.5, Math.min(1.91, el.naturalWidth / el.naturalHeight)))
                  }
                }}
              />
              {idx === i && badge}
            </div>
          )
        })}
      </div>
      <div className="carousel-dots">
        {slides.map((src, idx) => (
          <button
            key={src}
            className={'carousel-dot' + (idx === i ? ' on' : '')}
            aria-label={`Slide ${idx + 1} of ${slides.length}`}
            onClick={() => setI(idx)}
          />
        ))}
      </div>
    </div>
  )
}
