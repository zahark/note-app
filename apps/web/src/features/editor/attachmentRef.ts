/**
 * Attachment references, shared by the image and file nodes, the PDF viewer and the shared view: note
 * content refers to attachments as `attachment://<aid>`; the stored JSON (and the clipboard HTML) never
 * contains a real, private URL.
 */
export const ATTACHMENT_SCHEME = 'attachment://'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The `src` stored for attachment `aid`. */
export const attachmentSrc = (aid: string): string => `${ATTACHMENT_SCHEME}${aid}`

/** The attachment id in an `attachment://<aid>` src, or null for any other src. */
export function parseAttachmentSrc(src: unknown): string | null {
  if (typeof src !== 'string' || !src.startsWith(ATTACHMENT_SCHEME)) return null
  const aid = src.slice(ATTACHMENT_SCHEME.length)
  return UUID.test(aid) ? aid : null
}

/**
 * The attachment a pasted element refers to: our clipboard's `data-attachment-id`, else an
 * `attachment://` reference in `srcAttribute` (`src` for an `<img>`).
 */
export function elementAttachmentId(element: HTMLElement, srcAttribute = 'src'): string | null {
  const aid = element.getAttribute('data-attachment-id')
  if (aid && UUID.test(aid)) return aid
  return parseAttachmentSrc(element.getAttribute(srcAttribute))
}

/**
 * Maps an attachment id to a URL the browser can load: the owner's `/api/attachments/:aid`,
 * or a blob URL fetched by the shared view. May be async; it is only ever called by the node views.
 */
export type AttachmentResolver = (aid: string) => string | Promise<string>
