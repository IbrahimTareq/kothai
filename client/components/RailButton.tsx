// RailButton.tsx — one stop on the nav rail. The icon is all it shows, so the
// label names it twice: aria-label for the button itself (on a phone the rail
// is a tab bar and this is a tab, with no tip), and a <Tooltip> beside the
// rail on the desktop.
import { Icon } from './icons'
import { Tooltip } from '../ui/Tooltip'

export function RailButton({
  label,
  icon,
  size = 20,
  active,
  onClick,
}: {
  label: string
  icon: string
  size?: number
  active?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip label={label} side="right">
      <button className={`rail-btn${active ? ' active' : ''}`} aria-label={label} onClick={onClick}>
        <Icon name={icon} size={size} />
      </button>
    </Tooltip>
  )
}
