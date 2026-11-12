import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { AttachmentResolver } from './AttachmentImage'
import { PdfViewer } from './PdfViewer'

/** A `PdfViewer` rendered into a plain-DOM node view's slot. */
export interface PdfViewerMount {
  /** Shows attachment `aid` (a different id starts a fresh viewer). */
  update: (aid: string) => void
  /** Unmounts the viewer, which destroys its PDF. */
  destroy: () => void
}

/**
 * Renders a `PdfViewer` for `aid` into `slot` with its own React root. The `AttachmentFile` node view
 * is plain DOM (a `.ts` module), so it mounts the React viewer through this helper. Each mount gets
 * its own host element in the slot, so a later mount never reuses a container still being unmounted.
 */
export function mountPdfViewer(slot: HTMLElement, aid: string, resolveAttachment: AttachmentResolver | null): PdfViewerMount {
  const host = document.createElement('div')
  slot.append(host)
  const root = createRoot(host)
  let current = aid
  const render = () => root.render(createElement(PdfViewer, { key: current, aid: current, resolveAttachment }))
  render()

  let destroyed = false
  return {
    update: (next) => {
      if (destroyed || next === current) return
      current = next
      render()
    },
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
