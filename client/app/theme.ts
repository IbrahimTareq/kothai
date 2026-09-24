// Every surface's colour hangs off tokens that flip together, so fading them
// element by element would need a `transition` on everything. One snapshot
// crossfade (styled in foundation/base.css) moves the whole page at once.
export function applyTheme(doc: Document, theme: 'dark' | 'light') {
  const root = doc.documentElement
  // Nothing is on screen to fade from on first load: animating it would fade
  // the unthemed default into a saved light theme on every visit. Browsers
  // without view transitions just switch.
  if (!root.dataset.theme || root.dataset.theme === theme || !doc.startViewTransition) {
    root.dataset.theme = theme
    return
  }
  doc.startViewTransition(() => {
    root.dataset.theme = theme
  })
}
