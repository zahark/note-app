import { useQuery } from '@tanstack/react-query'
import type { JSONContent } from '@tiptap/core'
import { api } from '@/lib/api'
import type { TreeNote } from '@/features/tree/buildTree'

/** A note with its content, as returned by `GET /api/notes/:id`. */
export interface Note extends TreeNote {
  content: JSONContent
}

export const noteQueryKey = (id: string) => ['note', id] as const

const notePath = (id: string) => `/api/notes/${encodeURIComponent(id)}`

/**
 * Content saves still in flight, per note. Loading a note waits for them, so reopening a note right
 * after leaving it never shows (and then saves on top of) the content from before the last save.
 */
const inflightSaves = new Map<string, Promise<unknown>>()

function trackSave<T>(noteId: string, save: Promise<T>): Promise<T> {
  const settled = save.then(
    () => undefined,
    () => undefined,
  )
  inflightSaves.set(noteId, settled)
  void settled.then(() => {
    if (inflightSaves.get(noteId) === settled) inflightSaves.delete(noteId)
  })
  return save
}

/**
 * The open note with its content. It is fetched fresh every time a note is opened (nothing is kept
 * once the editor unmounts) and never refetched while open, so the editor is the only writer.
 */
export function useNote(id: string) {
  return useQuery({
    queryKey: noteQueryKey(id),
    queryFn: async ({ signal }) => {
      await inflightSaves.get(id)
      return (await api.get<{ note: Note }>(notePath(id), signal)).note
    },
    staleTime: Infinity,
    gcTime: 0,
    refetchOnReconnect: false,
  })
}

/** `PUT /api/notes/:id/content`: content and the version it was based on, never the title. */
export function saveNoteContent(noteId: string, content: JSONContent, version: number): Promise<{ version: number }> {
  return trackSave(noteId, api.put<{ version: number }>(`${notePath(noteId)}/content`, { content, version }))
}

/** Image types the server accepts (checked again there by magic bytes). */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** Why a file cannot be uploaded, or null if it looks acceptable. */
export function imageFileProblem(file: File): string | null {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name || 'This file'} is not a PNG, JPEG, WebP or GIF image`
  }
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name || 'This image'} is larger than 10 MB`
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
