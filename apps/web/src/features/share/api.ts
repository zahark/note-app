import type { QueryClient } from '@tanstack/react-query'
import type { JSONContent } from '@tiptap/core'
import { ACCEPTED_IMAGE_TYPES } from '@/features/editor/api'
import type { AttachmentResolver } from '@/features/editor/attachmentRef'
import { treeQueryKey, type TreeData, type TreeNote } from '@/features/tree/api'
import { patchNote } from '@/features/tree/mutations'
import { api, apiFetch, ApiError } from '@/lib/api'
import { clickDownload, DownloadRefusedError, fileDownloadName } from '@/lib/download'

// ---- owner side: enable, regenerate and stop sharing ----

export type ShareType = TreeNote['share_type']

/** Expiry choices for a signed link (the server accepts exactly these). */
export const EXPIRY_OPTIONS = [
  { value: '1h', label: '1 hour' },
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
] as const
export type ExpiryOption = (typeof EXPIRY_OPTIONS)[number]['value']

export type ShareRequest = { type: 'password_protected' } | { type: 'signed_url'; expires_in: ExpiryOption }

/** A PIN share as created: the PIN is in this response only, never again. */
export interface PinShare {
  type: 'password_protected'
  pin: string
}

/** A signed-link share as created: `url` is the full link to hand out. */
export interface SignedShare {
  type: 'signed_url'
  /** Unix seconds. */
  exp: number
  sig: string
  url: string
}

export type CreatedShare = PinShare | SignedShare

const shareApiPath = (noteId: string) => `/api/notes/${encodeURIComponent(noteId)}/share`

/** `POST /api/notes/:id/share`: enables sharing, or regenerates it (the previous PIN or link stops working). */
export async function createShare(noteId: string, request: ShareRequest): Promise<CreatedShare> {
  return (await api.post<{ share: CreatedShare }>(shareApiPath(noteId), request)).share
}

/** `DELETE /api/notes/:id/share`: back to private; every PIN, token and link stops working. */
export function stopSharing(noteId: string): Promise<void> {
  return api.delete<void>(shareApiPath(noteId))
}

/** The page a PIN share is opened at (the visitor also needs the PIN). */
export const sharedPageUrl = (noteId: string) => `${window.location.origin}/shared/${encodeURIComponent(noteId)}`

/** Records a note's new share state in the cached tree (sharing changes neither `version` nor the title). */
export function setTreeShareState(client: QueryClient, noteId: string, shareType: ShareType, expiresAt: number | null) {
  client.setQueryData<TreeData>(
    treeQueryKey,
    (tree) => tree && patchNote(tree, noteId, { share_type: shareType, expires_at: expiresAt }),
  )
}

/** A unix-seconds timestamp as local date and time. */
export const formatExpiry = (exp: number) =>
  new Date(exp * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** One line describing how a note is shared right now. */
export function shareStatusText(note: Pick<TreeNote, 'share_type' | 'expires_at'>, nowSec = Date.now() / 1000): string {
  if (note.share_type === 'password_protected') return 'Shared with a PIN.'
  if (note.share_type === 'signed_url') {
    if (note.expires_at === null) return 'Shared by a link.'
    return note.expires_at > nowSec
      ? `Shared by a link until ${formatExpiry(note.expires_at)}.`
      : `The link expired on ${formatExpiry(note.expires_at)}.`
  }
  return 'Not shared.'
}

// ---- visitor side: the public shared API ----

/**
 * What lets a visitor read a shared note: a token from a PIN unlock (sent only in the `Authorization`
 * header, kept in memory, never put in a URL), or the signed link's own `exp`/`sig`.
 */
export type SharedCredential = { kind: 'token'; token: string } | { kind: 'signed'; exp: string; sig: string }

/** `GET /api/shared/:id`: only the title, the content and the ids of the images it shows. */
export interface SharedNote {
  title: string
  content: JSONContent
  attachment_ids: string[]
}

const sharedApiPath = (noteId: string) => `/api/shared/${encodeURIComponent(noteId)}`

/** The URL and headers for a public shared API request carrying `credential`. */
function withCredential(path: string, credential: SharedCredential): { url: string; headers: Record<string, string> } {
  if (credential.kind === 'token') return { url: path, headers: { authorization: `Bearer ${credential.token}` } }
  const query = new URLSearchParams({ exp: credential.exp, sig: credential.sig })
  return { url: `${path}?${query.toString()}`, headers: {} }
}

/** `POST /api/shared/:id/unlock {pin}` → a 30-minute read token for that note. */
/** Wrong PIN, missing, private or link-only note: one message, so nothing is revealed. */
export const GENERIC_UNLOCK_ERROR = 'That PIN did not work, or this note is no longer shared.'

export function unlockSharedNote(noteId: string, pin: string): Promise<{ token: string; expires_at: number }> {
  return apiFetch(`${sharedApiPath(noteId)}/unlock`, { method: 'POST', body: { pin }, credentials: 'omit' })
}

/** `GET /api/shared/:id` with the visitor's credential. */
export async function fetchSharedNote(noteId: string, credential: SharedCredential, signal?: AbortSignal) {
  const { url, headers } = withCredential(sharedApiPath(noteId), credential)
  return (await apiFetch<{ note: SharedNote }>(url, { headers, signal, credentials: 'omit' })).note
}

/** The shared-attachment URL and headers for attachment `aid` of note `noteId`. */
const sharedAttachmentRequest = (noteId: string, aid: string, credential: SharedCredential) =>
  withCredential(`${sharedApiPath(noteId)}/attachments/${encodeURIComponent(aid)}`, credential)

export interface SharedAttachmentResolver {
  resolve: AttachmentResolver
  /**
   * Saves file attachment `aid`: fetched with the credential (as for `resolve`, sharing its cache),
   * then a blob-URL download named after the server's stored name (`fileDownloadName`). Rejects when
   * the file cannot be fetched, and with a `DownloadRefusedError` when the response is not a PDF or GPX
   * named as one (a file node pointing at an image); the caller reports it.
   */
  download: (aid: string) => Promise<void>
  /** (Re)opens the resolver after a `dispose`: the component mounted again (React StrictMode remounts once). */
  activate: () => void
  /**
   * Revokes every blob URL handed out so far and forgets them; a fetch still running then gets no
   * blob URL at all. `activate` undoes it.
   */
  dispose: () => void
}

interface LoadedAttachment {
  blobUrl: string
  /** The server's stored file name for a PDF or GPX (`fileDownloadName`); null for anything else, which is never saved. */
  fileName: string | null
}

const IMAGE_TYPES: ReadonlySet<string> = new Set(ACCEPTED_IMAGE_TYPES)

/**
 * Resolves `attachment://<aid>` images and files of a shared note to blob URLs: each attachment is
 * fetched once from `/api/shared/:id/attachments/:aid` with the credential (token in a header, never
 * in a URL). The PDF viewer reads its bytes from that blob URL, and a download saves it. A blob URL
 * has the app's origin and loses the file response's download and sandbox headers, so anything but an
 * image gets the type `application/octet-stream`: opened directly, it can never render on the app.
 */
export function createSharedAttachmentResolver(noteId: string, credential: SharedCredential): SharedAttachmentResolver {
  const cache = new Map<string, Promise<LoadedAttachment>>()
  const blobUrls = new Set<string>()
  // after dispose (the component unmounted), a fetch still running must not create (and leak) a blob URL
  let disposed = false

  const load = async (aid: string): Promise<LoadedAttachment> => {
    const { url, headers } = sharedAttachmentRequest(noteId, aid, credential)
    const res = await fetch(url, { headers, credentials: 'omit' })
    if (!res.ok) throw new ApiError(res.status, 'UNAVAILABLE', 'Attachment unavailable')
    const blob = await res.blob()
    if (disposed) throw new DOMException('Attachment no longer needed', 'AbortError')
    const typed = IMAGE_TYPES.has(blob.type) ? blob : new Blob([blob], { type: 'application/octet-stream' })
    const blobUrl = URL.createObjectURL(typed)
    blobUrls.add(blobUrl)
    return { blobUrl, fileName: fileDownloadName(res.headers) }
  }

  const get = (aid: string): Promise<LoadedAttachment> => {
    let pending = cache.get(aid)
    if (!pending) {
      const loading = load(aid)
      // a failed attachment may be retried the next time it is rendered or downloaded
      loading.catch(() => {
        if (cache.get(aid) === loading) cache.delete(aid)
      })
      cache.set(aid, loading)
      pending = loading
    }
    return pending
  }

  return {
    resolve: async (aid) => (await get(aid)).blobUrl,
    download: async (aid) => {
      const { blobUrl, fileName } = await get(aid)
      // never the node's name: only a PDF/GPX the server named as one is saved
      if (!fileName) throw new DownloadRefusedError()
      // the blob URL stays cached (and is revoked on dispose), so the browser can finish saving it
      clickDownload(blobUrl, fileName)
    },
    activate: () => {
      disposed = false
    },
    dispose: () => {
      disposed = true
      for (const blobUrl of blobUrls) URL.revokeObjectURL(blobUrl)
      blobUrls.clear()
      cache.clear()
    },
  }
}
