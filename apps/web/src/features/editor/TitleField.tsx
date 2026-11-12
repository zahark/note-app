import { useEffect, useRef, useState } from 'react'
import { useTree } from '@/features/tree/api'
import { UNTITLED } from '@/features/tree/buildTree'
import { useRenameNote } from '@/features/tree/mutations'
import { MAX_NAME_LENGTH } from '@/features/tree/treeOps'

interface TitleFieldProps {
  noteId: string
  /** The title the note was loaded with (used until the tree knows it). */
  loadedTitle: string
  onEnter: () => void
}

/**
 * The note title. It is saved through the rename endpoint (`PATCH /api/notes/:id {title}`), never by
 * autosave, on Enter, blur, or when the note is closed. It shows the title from the tree, so a rename
 * from the sidebar appears here too.
 */
export function TitleField({ noteId, loadedTitle, onEnter }: TitleFieldProps) {
  const tree = useTree()
  const renameNote = useRenameNote()
  const title = tree.data?.notes.find((n) => n.id === noteId)?.title ?? loadedTitle
  // what the user is typing; null = not editing (show the saved title)
  const [draft, setDraft] = useState<string | null>(null)

  const commit = () => {
    if (draft !== null && draft !== title) renameNote.mutate({ id: noteId, title: draft })
    setDraft(null)
  }

  // closing the note while the title is being edited still saves it
  const pending = useRef<{ draft: string | null; title: string }>({ draft, title })
  useEffect(() => {
    pending.current = { draft, title }
  })
  const rename = renameNote.mutate
  useEffect(
    () => () => {
      const { draft: d, title: t } = pending.current
      if (d !== null && d !== t) rename({ id: noteId, title: d })
    },
    [noteId, rename],
  )

  return (
    <input
      aria-label="Note title"
      placeholder={UNTITLED}
      maxLength={MAX_NAME_LENGTH.note}
      value={draft ?? title}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
          onEnter()
        } else if (event.key === 'Escape') {
          setDraft(null)
        }
      }}
      className="min-w-0 flex-1 bg-transparent text-2xl font-semibold outline-none placeholder:text-muted-foreground/60"
    />
  )
}
