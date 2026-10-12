// A space canvas's command row: add a note or a frame, and tidy. Its own
// module because Canvas.tsx sat at its line budget with no room for Tidy's Undo.
import { Button } from '../ui/Button'

export function CanvasBar({
  onNote,
  onFrame,
  onTidy,
}: {
  onNote: () => void
  onFrame: () => void
  onTidy: () => void
}) {
  return (
    <div className="cv-bar">
      <div className="cv-add">
        <Button size="xs" tone="ghost" onClick={onNote}>
          + Note
        </Button>
        <Button size="xs" tone="ghost" onClick={onFrame}>
          + Frame
        </Button>
      </div>
      <div className="cv-cmds">
        <Button size="xs" tone="ghost" onClick={onTidy}>
          Tidy
        </Button>
      </div>
    </div>
  )
}
