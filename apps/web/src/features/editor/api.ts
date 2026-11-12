import { useQuery } from '@tanstack/react-query'
import type { JSONContent } from '@tiptap/core'
import type { TreeNote } from '@/features/tree/api'
import { api } from '@/lib/api'

/** A note with its content, as returned by `GET /api/notes/:id`. */
export interface Note extends TreeNote {
  content: JSONContent
}

export const noteQueryKey = (id: string) => ['note', id] as const

const notePath = (id: string) => `/api/notes/${encodeURIComponent(id)}`

/** What the registry needs from an autosaver (see `Autosaver`). */
export interface RegisteredSaver {
  /** Whether some change is not on the server yet. */
  readonly hasUnsavedChanges: boolean
  /** Saves pending content now (or right after the save in flight). */
  flush(): void
  /** Drops pending content and stops retrying (test isolation only). */
  cancel(): void
  /** Resolves once nothing is left to save, or saving stopped for good (a conflict or an error retrying cannot fix). */
  whenSettled(): Promise<void>
  /** Resolves once no save is in flight or queued (a failed one may still be retried later). */
  whenIdle(): Promise<void>
}

/**
 * Every autosaver that is open in an editor or still has changes to save, with its note id. An
 * editor's saver stays here after the editor closes until it settles, so edits whose last save
 * failed are still retried, still covered by the unsaved-changes prompt, still saved before
 * signing out, and still waited for when the note is opened again.
 */
const savers = new Map<RegisteredSaver, string>()

function onBeforeUnload(event: BeforeUnloadEvent): void {
  let unsaved = false
  for (const saver of savers.keys()) {
    if (!saver.hasUnsavedChanges) continue
    unsaved = true
    saver.flush()
  }
  if (unsaved) event.preventDefault()
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'hidden') return
  for (const saver of savers.keys()) saver.flush()
}

/**
 * Registers an autosaver for note `noteId` (registering it again is a no-op); returns the function
 * that unregisters it. While any saver is registered, hiding the tab saves pending changes at once
 * and closing it with unsaved changes asks for confirmation.
 */
export function registerSaver(noteId: string, saver: RegisteredSaver): () => void {
  if (savers.size === 0) {
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  savers.set(saver, noteId)
  return () => unregisterSaver(saver)
}

function unregisterSaver(saver: RegisteredSaver): void {
  if (!savers.delete(saver) || savers.size > 0) return
  window.removeEventListener('beforeunload', onBeforeUnload)
  document.removeEventListener('visibilitychange', onVisibilityChange)
}

/** Cancels and forgets every saver (test isolation only: a held-back save must not block later tests). */
export function resetSavers(): void {
  for (const saver of [...savers.keys()]) {
    saver.cancel()
    unregisterSaver(saver)
  }
}

/**
 * Resolves once note `id` has nothing left to save. Loading a note waits for this, so reopening a
 * note right after leaving it never shows (and then saves on top of) the content from before its
 * last save, even while that save is being retried. A pending retry is sent at once.
 */
async function savesSettled(id: string): Promise<void> {
  const ofNote = [...savers].filter(([, noteId]) => noteId === id).map(([saver]) => saver)
  for (const saver of ofNote) saver.flush()
  await Promise.all(ofNote.map((saver) => saver.whenSettled()))
}

/**
 * Sends every pending change (open notes and closed ones whose save is being retried) now and
 * resolves once no content save is in flight (failed ones included). Signing out waits for this, so
 * the last edits are saved while the session still exists.
 */
export async function flushAllSaves(): Promise<void> {
  const all = [...savers.keys()]
  for (const saver of all) saver.flush()
  await Promise.all(all.map((saver) => saver.whenIdle()))
}

/**
 * The open note with its content. It is fetched fresh every time a note is opened (nothing is kept
 * once the editor unmounts) and never refetched while open, so the editor is the only writer.
 */
export function useNote(id: string) {
  return useQuery({
    queryKey: noteQueryKey(id),
    queryFn: async ({ signal }) => {
      await savesSettled(id)
      return (await api.get<{ note: Note }>(notePath(id), signal)).note
    },
    staleTime: Infinity,
    gcTime: 0,
    refetchOnReconnect: false,
  })
}

/** `PUT /api/notes/:id/content`: content and the version it was based on, never the title. */
export function saveNoteContent(noteId: string, content: JSONContent, version: number): Promise<{ version: number }> {
  return api.put<{ version: number }>(`${notePath(noteId)}/content`, { content, version })
}

/** Image types the server accepts (checked again there by magic bytes). */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
const MIB = 1024 * 1024
/** Largest image the server accepts (`MAX_IMAGE_BYTES` on the server). */
export const MAX_ATTACHMENT_BYTES = 10 * MIB

/** Why a file cannot be uploaded, or null if it looks acceptable. */
export function imageFileProblem(file: File): string | null {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name || 'This file'} is not a PNG, JPEG, WebP or GIF image`
  }
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name || 'This image'} is larger than ${MAX_ATTACHMENT_BYTES / MIB} MB`
  return null
}

/** `POST /api/attachments`: uploads one image and returns its attachment id. */
export async function uploadAttachment(file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file, file.name)
  const { id } = await api.post<{ id: string }>('/api/attachments', form)
  return id
}

/** The owner's URL for an attachment; used only inside the image node view, never stored. */
export const ownerAttachmentUrl = (aid: string) => `/api/attachments/${encodeURIComponent(aid)}`

/** The files in a paste or drop that should be handled as image uploads (any `image/*`, so unsupported ones get a message). */
export function imageFilesFrom(data: DataTransfer | null | undefined): File[] {
  if (!data?.files) return []
  return Array.from(data.files).filter((file) => file.type.startsWith('image/'))
}
