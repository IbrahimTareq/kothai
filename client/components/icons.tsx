// Icon set (minimal line glyphs) + the category registry.
//
// Four glyphs are Lucide's (https://lucide.dev, ISC): layout-dashboard,
// message-square-text, playing-cards-fan and plus. Their path data is inlined
// rather than pulled from lucide-react so the whole set stays one <Icon
// name="…"> component with no second icon system beside it — Lucide's own SVG
// attributes (24x24, no fill, currentColor stroke, round caps and joins) are
// already exactly what `p` below sets, so they drop straight in and take the
// app's lighter default stroke weight.
import type { ReactElement, SVGProps } from 'react'
import type { Category, UIType } from '../types'

interface IconProps {
  name: string
  size?: number
  stroke?: number
}

export function Icon({ name, size = 18, stroke = 1.6 }: IconProps): ReactElement | null {
  const p: SVGProps<SVGSVGElement> = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: stroke,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }
  switch (name) {
    case 'core': return (<svg {...p}><circle cx="12" cy="12" r="7" /><path d="M12 5a7 9 0 0 0 0 14M12 5a7 9 0 0 1 0 14M5 12h14" /></svg>)
    // lucide: layout-dashboard
    case 'all': return (<svg {...p}><rect width="7" height="9" x="3" y="3" rx="1" /><rect width="7" height="5" x="14" y="3" rx="1" /><rect width="7" height="9" x="14" y="12" rx="1" /><rect width="7" height="5" x="3" y="16" rx="1" /></svg>)
    case 'link': return (<svg {...p}><path d="M9.5 14.5l5-5" /><path d="M8 11l-2 2a3.5 3.5 0 0 0 5 5l2-2" /><path d="M16 13l2-2a3.5 3.5 0 0 0-5-5l-2 2" /></svg>)
    case 'image': return (<svg {...p}><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M5 18l4.5-4.5 3 3L17 12l3 3" /></svg>)
    case 'video': return (<svg {...p}><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="M10.5 9.5l4 2.5-4 2.5z" fill="currentColor" stroke="none" /></svg>)
    case 'note': return (<svg {...p}><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" /><path d="M13.5 3.5V8h4.5M8.5 13h7M8.5 16.5h5" /></svg>)
    case 'code': return (<svg {...p}><path d="M9 8l-4 4 4 4M15 8l4 4-4 4" /></svg>)
    // open book — the source mark on a link tile that has no platform behind it
    case 'article': return (<svg {...p}><path d="M12 7.2C10.4 6.1 8.4 5.5 6 5.5H3.5v12H6c2.4 0 4.4.6 6 1.7 1.6-1.1 3.6-1.7 6-1.7h2.5v-12H18c-2.4 0-4.4.6-6 1.7z" /><path d="M12 7.2v12" /></svg>)
    // lucide: message-square-text
    case 'ask': return (<svg {...p}><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" /><path d="M7 11h10" /><path d="M7 15h6" /><path d="M7 7h8" /></svg>)
    // grid density selectors — filled square-grid, denser left→right (4 / 6 / 8)
    case 'grid4': return (<svg {...p}><rect x="4.0" y="4.0" width="6.4" height="6.4" rx="1.6" fill="currentColor" stroke="none" /><rect x="13.6" y="4.0" width="6.4" height="6.4" rx="1.6" fill="currentColor" stroke="none" /><rect x="4.0" y="13.6" width="6.4" height="6.4" rx="1.6" fill="currentColor" stroke="none" /><rect x="13.6" y="13.6" width="6.4" height="6.4" rx="1.6" fill="currentColor" stroke="none" /></svg>)
    case 'grid6': return (<svg {...p}><rect x="4.0" y="4.0" width="4.0" height="4.0" rx="1.0" fill="currentColor" stroke="none" /><rect x="10.0" y="4.0" width="4.0" height="4.0" rx="1.0" fill="currentColor" stroke="none" /><rect x="16.0" y="4.0" width="4.0" height="4.0" rx="1.0" fill="currentColor" stroke="none" /><rect x="4.0" y="10.0" width="4.0" height="4.0" rx="1.0" fill="currentColor" stroke="none" /><rect x="10.0" y="10.0" width="4.0" height="4.0" rx="1.0" fill="currentColor" stroke="none" /><rect x="16.0" y="10.0" width="4.0" height="4.0" rx="1.0" fill="currentColor" stroke="none" /><rect x="4.0" y="16.0" width="4.0" height="4.0" rx="1.0" fill="currentColor" stroke="none" /><rect x="10.0" y="16.0" width="4.0" height="4.0" rx="1.0" fill="currentColor" stroke="none" /><rect x="16.0" y="16.0" width="4.0" height="4.0" rx="1.0" fill="currentColor" stroke="none" /></svg>)
    case 'grid8': return (<svg {...p}><rect x="4.1" y="4.1" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="8.4" y="4.1" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="12.7" y="4.1" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="17.0" y="4.1" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="4.1" y="8.4" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="8.4" y="8.4" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="12.7" y="8.4" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="17.0" y="8.4" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="4.1" y="12.7" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="8.4" y="12.7" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="12.7" y="12.7" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="17.0" y="12.7" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="4.1" y="17.0" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="8.4" y="17.0" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="12.7" y="17.0" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /><rect x="17.0" y="17.0" width="2.9" height="2.9" rx="0.7" fill="currentColor" stroke="none" /></svg>)
    case 'send': return (<svg {...p}><path d="M4 12l16-7-7 16-2.5-6.5L4 12z" /></svg>)
    // lucide: plus
    case 'plus': return (<svg {...p}><path d="M5 12h14" /><path d="M12 5v14" /></svg>)
    // single stroke on purpose — the capture button draws it with a
    // dash-offset sweep, which needs one continuous path (see card.css)
    case 'check': return (<svg {...p}><path d="M5 12.5l4.5 4.5L19 8" /></svg>)
    case 'play': return (<svg {...p}><path d="M8 6l11 6-11 6z" fill="currentColor" stroke="none" /></svg>)
    case 'external': return (<svg {...p}><path d="M14 5h5v5M19 5l-8 8M11 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" /></svg>)
    // filled square — the composer's send button becomes this while an answer
    // is in flight, the way a transport control does
    case 'stop': return (<svg {...p}><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" /></svg>)
    case 'copy': return (<svg {...p}><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15V6a1 1 0 0 1 1-1h9" /></svg>)
    case 'search': return (<svg {...p}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></svg>)
    case 'spark': return (<svg {...p}><path d="M12 4l1.6 5.4L19 11l-5.4 1.6L12 18l-1.6-5.4L5 11l5.4-1.6z" /></svg>)
    // The Spaces destination. Deliberately NOT the same glyph as 'spark' above:
    // that one is the smart-space marker, shown at 11px on a tile corner and on
    // rule-driven rows, where it means "fills itself" rather than "spaces".
    // lucide: playing-cards-fan
    case 'spaces': return (<svg {...p}><path d="M12.65 7.65a2 2 0 012.629-1.046l5.51 2.374a2 2 0 011.046 2.628l-3.957 9.184a2 2 0 01-2.628 1.046l-5.51-2.374a2 2 0 01-1.046-2.628z" /><path d="M18 7.777V4a2 2 0 00-2-2h-6a2 2 0 00-2 2v10a2 2 0 001.137 1.805" /><path d="m8 4.389-4.364.809a2 2 0 00-1.602 2.33l1.822 9.833a2 2 0 002.331 1.602l2.542-.47" /></svg>)
    case 'trash': return (<svg {...p}><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" /></svg>)
    case 'retag': return (<svg {...p}><path d="M4 12a8 8 0 0 1 13.66-5.66L20 8M20 4v4h-4" /><path d="M20 12a8 8 0 0 1-13.66 5.66L4 16M4 20v-4h4" /></svg>)
    case 'expand': return (<svg {...p}><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>)
    case 'close': return (<svg {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>)
    case 'edit': return (<svg {...p}><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M14 6l4 4" /></svg>)
    case 'chevron': return (<svg {...p}><path d="M6 9l6 6 6-6" /></svg>)
    case 'more': return (<svg {...p}><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" /></svg>)
    case 'settings': return (<svg {...p}><path d="M18.86 10.16 L21.26 10.37 L21.26 13.63 L18.86 13.84 L18.15 15.55 L19.7 17.39 L17.39 19.7 L15.55 18.15 L13.84 18.86 L13.63 21.26 L10.37 21.26 L10.16 18.86 L8.45 18.15 L6.61 19.7 L4.3 17.39 L5.85 15.55 L5.14 13.84 L2.74 13.63 L2.74 10.37 L5.14 10.16 L5.85 8.45 L4.3 6.61 L6.61 4.3 L8.45 5.85 L10.16 5.14 L10.37 2.74 L13.63 2.74 L13.84 5.14 L15.55 5.85 L17.39 4.3 L19.7 6.61 L18.15 8.45 Z" /><circle cx="12" cy="12" r="3.1" /></svg>)
    // sun glyph — used by the light/dark mode toggle
    case 'theme': return (<svg {...p}><circle cx="12" cy="12" r="3.2" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" /></svg>)
    // brand glyphs for source filter pills — filled single-colour, theme-aware via currentColor
    case 'instagram': return (<svg {...p} fill="currentColor" stroke="none"><path d="M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077" /></svg>)
    case 'github': return (<svg {...p} fill="currentColor" stroke="none"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>)
    case 'reddit': return (<svg {...p} fill="currentColor" stroke="none"><path d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z" /></svg>)
    case 'x': return (<svg {...p} fill="currentColor" stroke="none"><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" /></svg>)
    case 'youtube': return (<svg {...p} fill="currentColor" stroke="none"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" /></svg>)
    case 'tiktok': return (<svg {...p} fill="currentColor" stroke="none"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" /></svg>)
    // generic globe for the catch-all "Web" source (matches the line-icon style)
    case 'web': return (<svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.4 3.9 5.6 4 9-.1 3.4-1.5 6.6-4 9-2.5-2.4-3.9-5.6-4-9 .1-3.4 1.5-6.6 4-9z" /></svg>)
    default: return null
  }
}

// Category registry. `core` and `ask` are modes, not storable types.
export const CATEGORIES: Category[] = [
  { id: 'link', label: 'Links', glyph: 'link' },
  { id: 'image', label: 'Images', glyph: 'image' },
  { id: 'video', label: 'Videos', glyph: 'video' },
  { id: 'note', label: 'Notes', glyph: 'note' },
  { id: 'code', label: 'Code', glyph: 'code' },
]

export const CAT: Record<UIType, Category> = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c]),
) as Record<UIType, Category>
