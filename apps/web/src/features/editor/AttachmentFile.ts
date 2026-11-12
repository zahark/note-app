import { Node } from '@tiptap/core'
import { FILE_KINDS, type FileKind } from '@/lib/fileTypes'
import { KIB, MIB } from '@/lib/units'
import { attachmentSrc, elementAttachmentId, parseAttachmentSrc, type AttachmentResolver } from './attachmentRef'
import type { PdfPreviewErrorHandler } from './PdfViewer'
import { mountPdfViewer } from './pdfViewerMount'

/** `kind` as a known file kind, or null for anything else (stored or pasted content is untrusted). */
function parseFileKind(value: unknown): FileKind | null {
  return (FILE_KINDS as readonly unknown[]).includes(value) ? (value as FileKind) : null
}

/** `size` as a non-negative whole number of bytes, or null. */
function parseFileSize(value: unknown): number | null {
  const size = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null
}

/** A short human-readable size: `512 B`, `1.5 KB`, `12.3 MB`. */
export function formatFileSize(bytes: number): string {
  if (bytes < KIB) return `${bytes} B`
  if (bytes < MIB) return `${(bytes / KIB).toFixed(1)} KB`
  return `${(bytes / MIB).toFixed(1)} MB`
}

/** The name shown for a file node: its stored name, else a fallback per kind (as the server's `displayName`). */
export function fileDisplayName(name: unknown, kind: FileKind | null): string {
  if (typeof name === 'string' && name.trim() !== '') return name
  if (kind === 'pdf') return 'document.pdf'
  if (kind === 'gpx') return 'track.gpx'
  return 'file'
}

/**
 * Downloads attachment `aid`: the owner fetches `/api/attachments/:aid` with the session, the shared
 * view with its credential, and each saves a blob under the server's file name. `displayName` is the
 * chip's name, used only in the handler's error messages, never as the download name. The handler
 * reports its own errors.
 */
export type AttachmentDownloader = (aid: string, displayName: string) => void

export interface AttachmentFileOptions {
  /** Maps `attachment://<aid>` to a loadable URL (the PDF viewer's bytes). */
  resolveAttachment: AttachmentResolver | null
  /** Called by the Download button. Without one the button is disabled. */
  downloadAttachment: AttachmentDownloader | null
  /** Told when a PDF preview fails (the owner's editor sends an expired session to login). */
  onPreviewError: PdfPreviewErrorHandler | null
}

/** Marks our file blocks in the clipboard HTML. */
const FILE_BLOCK_TYPE = 'attachment-file'
const FILE_BLOCK_SELECTOR = `div[data-type="${FILE_BLOCK_TYPE}"]`

/**
 * TipTap block node for a non-image attachment (`kind` `pdf` or `gpx`), stored as
 * `{type:'attachmentFile', attrs:{src:'attachment://<aid>', name, size, kind}}`.
 *
 * - Same reference rules as `AttachmentImage`: `src` is only ever `attachment://<aid>`; `renderHTML`
 *   (clipboard, `getHTML()`) keeps the reference plus `data-attachment-id` and never a resolved URL,
 *   and a pasted file block without an `attachment://` reference is dropped with its content.
 * - `name`, `size` and `kind` are display-only, untrusted text: the node view sets them with
 *   `textContent`, never as HTML. The download's file name comes from the server.
 * - The node view is a chip (kind badge, name, size, Download button); a `pdf` node with a valid
 *   reference also gets a viewer slot (`data-role="pdf-viewer"`) with the `PdfViewer` mounted in it
 *   once (its bytes come from `resolveAttachment`), unmounted when the node view is destroyed. Nothing
 *   changes a node's `src` or `kind` in place; if something did, the node view is rebuilt.
 */
export const AttachmentFile = Node.create<AttachmentFileOptions>({
  name: 'attachmentFile',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { resolveAttachment: null, downloadAttachment: null, onPreviewError: null }
  },

  addAttributes() {
    return {
      src: {
        default: null,
        rendered: false,
        parseHTML: (element: HTMLElement) => {
          const aid = elementAttachmentId(element, 'data-src')
          return aid ? attachmentSrc(aid) : null
        },
      },
      name: {
        default: null,
        rendered: false,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-name'),
      },
      size: {
        default: null,
        rendered: false,
        parseHTML: (element: HTMLElement) => parseFileSize(element.getAttribute('data-size')),
      },
      kind: {
        default: null,
        rendered: false,
        parseHTML: (element: HTMLElement) => parseFileKind(element.getAttribute('data-kind')),
      },
    }
  },

  parseHTML() {
    return [
      // our clipboard HTML with a valid reference
      { tag: FILE_BLOCK_SELECTOR, getAttrs: (element) => (elementAttachmentId(element, 'data-src') ? null : false) },
      // any other file block is dropped together with its text, so it never turns into a paragraph
      { tag: FILE_BLOCK_SELECTOR, ignore: true },
    ]
  },

  renderHTML({ node }) {
    const aid = parseAttachmentSrc(node.attrs.src)
    const kind = parseFileKind(node.attrs.kind)
    const size = parseFileSize(node.attrs.size)
    const name = typeof node.attrs.name === 'string' ? node.attrs.name : null
    return [
      'div',
      {
        'data-type': FILE_BLOCK_TYPE,
        ...(aid ? { 'data-src': attachmentSrc(aid), 'data-attachment-id': aid } : {}),
        ...(name != null ? { 'data-name': name } : {}),
        ...(size != null ? { 'data-size': String(size) } : {}),
        ...(kind ? { 'data-kind': kind } : {}),
      },
      // a text child (escaped by the serializer) so a plain-text paste shows the file name
      fileDisplayName(name, kind),
    ]
  },

  renderText({ node }) {
    return fileDisplayName(node.attrs.name, parseFileKind(node.attrs.kind))
  },

  addNodeView() {
    const download = this.options.downloadAttachment
    const resolve = this.options.resolveAttachment
    const onPreviewError = this.options.onPreviewError

    return ({ node: initialNode }) => {
      let node = initialNode
      const aid = parseAttachmentSrc(node.attrs.src)
      const kind = parseFileKind(node.attrs.kind)

      const dom = document.createElement('div')
      dom.classList.add('attachment-file')
      if (aid) dom.setAttribute('data-attachment-id', aid)
      if (kind) dom.setAttribute('data-kind', kind)

      const chip = document.createElement('div')
      chip.className = 'attachment-file-chip'
      const badge = document.createElement('span')
      badge.className = 'attachment-file-badge'
      badge.setAttribute('aria-hidden', 'true')
      badge.textContent = kind ? kind.toUpperCase() : 'FILE'
      const nameEl = document.createElement('span')
      nameEl.className = 'attachment-file-name'
      nameEl.setAttribute('data-role', 'name')
      const sizeEl = document.createElement('span')
      sizeEl.className = 'attachment-file-size'
      sizeEl.setAttribute('data-role', 'size')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'attachment-file-download'
      button.textContent = 'Download'
      button.disabled = !aid || !download
      chip.append(badge, nameEl, sizeEl, button)
      dom.append(chip)

      // the viewer shows a PDF with a valid reference; it is never mounted for any other kind
      let viewerSlot: HTMLElement | null = null
      let destroyViewer: (() => void) | null = null
      if (kind === 'pdf' && aid) {
        viewerSlot = document.createElement('div')
        viewerSlot.className = 'attachment-file-viewer'
        viewerSlot.setAttribute('data-role', 'pdf-viewer')
        dom.append(viewerSlot)
        destroyViewer = mountPdfViewer(viewerSlot, aid, resolve, onPreviewError).destroy
      }

      const displayName = () => fileDisplayName(node.attrs.name, kind)

      /** Refreshes the display-only attrs (name, size). */
      const render = () => {
        const name = displayName()
        const size = parseFileSize(node.attrs.size)
        // untrusted text: textContent only, never innerHTML
        nameEl.textContent = name
        nameEl.title = name
        sizeEl.textContent = size != null ? formatFileSize(size) : ''
        button.setAttribute('aria-label', `Download ${name}`)
      }

      button.addEventListener('click', (event) => {
        event.preventDefault()
        if (aid && download) download(aid, displayName())
      })

      render()

      return {
        dom,
        update: (updated) => {
          // a different attachment or kind needs a different view (and viewer): let ProseMirror rebuild it
          if (updated.type !== node.type || updated.attrs.src !== node.attrs.src || updated.attrs.kind !== node.attrs.kind) {
            return false
          }
          node = updated
          render()
          return true
        },
        // the editor must not treat clicks on the chip's controls (or the viewer) as editing
        stopEvent: (event) => {
          const target = event.target
          return target instanceof Element && (button.contains(target) || !!viewerSlot?.contains(target))
        },
        ignoreMutation: () => true,
        destroy: () => destroyViewer?.(),
      }
    }
  },
})
