import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { AttachmentResolver } from './attachmentRef'
import { PdfViewer, type PdfPreviewErrorHandler } from './PdfViewer'

/** A `PdfViewer` rendered into a plain-DOM node view's slot. */
export interface PdfViewerMount {
  /** Unmounts the viewer (which destroys its PDF) and removes its host element; safe to call twice. */
  destroy: () => void
}

/**
 * Renders a `PdfViewer` for `aid` into `slot` with its own React root (`onError` is told when the
 * preview fails). The `AttachmentFile` node view is plain DOM (a `.ts` module), so it mounts the React
 * viewer through this helper. Each mount gets its own host element in the slot, so a later mount never
 * reuses a container still being unmounted.
 */
export function mountPdfViewer(
  slot: HTMLElement,
  aid: string,
  resolveAttachment: AttachmentResolver | null,
  onError: PdfPreviewErrorHandler | null = null,
): PdfViewerMount {
  const host = document.createElement('div')
  slot.append(host)
  const root = createRoot(host)
  root.render(createElement(PdfViewer, { aid, resolveAttachment, onError }))

  let destroyed = false
  return {
    destroy: () => {
      if (destroyed) return
      destroyed = true
      // a node view can be destroyed while React is rendering (the editor unmounting with its
      // component); unmounting another root synchronously then would warn, so wait a microtask
      queueMicrotask(() => {
        root.unmount()
        host.remove()
      })
    },
  }
}
