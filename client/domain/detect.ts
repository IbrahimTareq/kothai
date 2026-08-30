// Client-side type detection — the heart of "paste anything, it figures it
// out". This drives only the live "detect chip" preview; the server re-classifies
// authoritatively on save (see server/ai/normalise.js heuristicType/extractUrl).
// Remote providers skip first-run onboarding: /api/status reports configured
// when the provider does not download weights, so this detector is unchanged.
import type { Detection } from '../types'

export function detectType(raw: string): Detection | null {
  const t = (raw || '').trim()
  if (!t) return null

  // explicit fenced code
  if (/^```/.test(t)) return { type: 'code', lang: (t.match(/^```(\w+)/) || [])[1] || 'text' }

  // data: image
  if (/^data:image\//.test(t)) return { type: 'image' }

  // url detection
  const urlMatch = t.match(/\bhttps?:\/\/[^\s]+/i) || t.match(/^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?$/i)
  if (urlMatch && t.split(/\s+/).length <= 4) {
    const url = urlMatch[0].startsWith('http') ? urlMatch[0] : 'https://' + urlMatch[0]
    let host = ''
    try {
      host = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      host = url
    }
    if (/\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(url)) return { type: 'image', url, host }
    if (/(youtube\.com|youtu\.be|vimeo\.com|\.mp4|\.mov|\.webm)/i.test(url)) return { type: 'video', url, host }
    return { type: 'link', url, host }
  }

  // code heuristics
  const codeSignals = [/[;{}]\s*$/m, /\b(function|const|let|var|=>|import|export|def|class|return|public|void|SELECT|FROM)\b/, /^\s{2,}\S/m, /<\/?[a-z][\s\S]*>/i]
  const codeScore = codeSignals.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0)
  if (codeScore >= 2 && t.length < 1200) return { type: 'code', lang: guessLang(t) }

  return { type: 'note' }
}

function guessLang(t: string): string {
  if (/SELECT|FROM|WHERE/i.test(t)) return 'sql'
  if (/def |import |print\(|:\s*$/m.test(t)) return 'python'
  if (/<\/?[a-z]/i.test(t) && /class=|<div|<span/.test(t)) return 'html'
  if (/\{[^}]*:[^}]*\}/.test(t) && /(color|margin|padding|flex|grid)/.test(t)) return 'css'
  if (/\$|echo |cd |npm |git /.test(t)) return 'bash'
  return 'js'
}
