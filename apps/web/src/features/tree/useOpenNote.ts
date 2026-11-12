import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

/** Query-string key holding the open note's id (`/?note=<id>`). */
export const NOTE_PARAM = 'note'

/** The open note's id (from `?note=`) and functions to open another note or close it. */
export function useOpenNote() {
  const [searchParams, setSearchParams] = useSearchParams()
  const setNote = useCallback(
    (id: string | null) =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        if (id === null) next.delete(NOTE_PARAM)
        else next.set(NOTE_PARAM, id)
        return next
      }),
    [setSearchParams],
  )
  const openNote = useCallback((id: string) => setNote(id), [setNote])
  const closeNote = useCallback(() => setNote(null), [setNote])
  return { noteId: searchParams.get(NOTE_PARAM), openNote, closeNote }
}
