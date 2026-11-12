import { cn } from 'cn'
import type { SaveStatus } from './useAutosave'

const STATUS_TEXT: Record<Exclude<SaveStatus, 'conflict'>, string> = {
  saved: 'Saved',
  pending: 'Saving…',
  saving: 'Saving…',
  error: 'Error saving',
}

interface SaveIndicatorProps {
  status: SaveStatus
  /** Why saving failed, when retrying cannot help (e.g. the note is too large). */
  error: string | null
  uploading: boolean
}

/** The save state of the open note (or the image upload in progress). */
export function SaveIndicator({ status, error, uploading }: SaveIndicatorProps) {
  const text = uploading
    ? 'Uploading image…'
    : status === 'conflict'
      ? 'Not saved'
      : status === 'error' && error
        ? `Not saved: ${error}`
        : STATUS_TEXT[status]
  const bad = status === 'error' || status === 'conflict'
  return (
    <span
      role="status"
      aria-label="Save status"
      className={cn('mt-2 max-w-48 shrink-0 text-right text-xs', bad ? 'text-destructive' : 'text-muted-foreground')}
    >
      {text}
    </span>
  )
}
