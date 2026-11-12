import { mergeAttributes } from '@tiptap/core'
import { Image, type ImageOptions } from '@tiptap/extension-image'

/**
 * Images stored in note content reference attachments as `attachment://<aid>`; the stored JSON
 * (and the clipboard HTML) never contains a real, private URL.
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
 * Maps an attachment id to a URL the browser can load: the owner's `/api/attachments/:aid`,
 * or a blob URL fetched by the shared view. May be async; it is only ever called by the node view.
 */
export type AttachmentResolver = (aid: string) => string | Promise<string>

export interface AttachmentImageOptions extends ImageOptions {
  /** Resolves `attachment://<aid>` for display. Without one the src is shown as stored. */
  resolveAttachment: AttachmentResolver | null
}

/** Attributes copied onto the displayed `<img>` (the src is handled separately). */
const DISPLAY_ATTRIBUTES = ['alt', 'title', 'width', 'height'] as const

/**
 * TipTap image node whose `src` may be `attachment://<aid>`.
 *
 * - The reference is resolved to a loadable URL **only inside the node view** (the `<img>` the
 *   editor displays), through the `resolveAttachment` option.
 * - `renderHTML` (used for the clipboard and `getHTML()`) keeps `src="attachment://<aid>"` and adds
 *   `data-attachment-id`; `parseHTML` reads either back into `attachment://<aid>`. So copy, cut and
 *   paste, within a note or across notes, keep the reference, and `getJSON()` never contains a
 *   private route.
 * - Any other src is displayed unchanged.
 */
export const AttachmentImage = Image.extend<AttachmentImageOptions>({
  addOptions() {
    return {
      ...this.parent!(),
      resolveAttachment: null,
    }
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const aid = element.getAttribute('data-attachment-id')
          if (aid && UUID.test(aid)) return attachmentSrc(aid)
          return element.getAttribute('src')
        },
      },
    }
  },

  parseHTML() {
    return [
      // our own clipboard HTML: the reference wins over whatever the src says
      { tag: 'img[data-attachment-id]', priority: 60 },
      { tag: 'img[src]:not([src^="data:"])' },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    const aid = parseAttachmentSrc(HTMLAttributes.src)
    return [
      'img',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, aid ? { 'data-attachment-id': aid } : {}),
    ]
  },

  addNodeView() {
    const resolve = this.options.resolveAttachment
    const extraAttributes = this.options.HTMLAttributes

    return ({ node: initialNode }) => {
      let node = initialNode
      const img = document.createElement('img')
      for (const [key, value] of Object.entries(extraAttributes)) {
        if (value != null) img.setAttribute(key, String(value))
      }
      // a counter so a slow async resolution never overwrites a newer src
      let generation = 0

      const applySrc = (src: unknown) => {
        const current = ++generation
        const aid = parseAttachmentSrc(src)
        if (aid) img.setAttribute('data-attachment-id', aid)
        else img.removeAttribute('data-attachment-id')

        if (typeof src !== 'string' || src === '') {
          img.removeAttribute('src')
          return
        }
        if (!aid || !resolve) {
          img.setAttribute('src', src)
          return
        }
        let resolved: string | Promise<string>
        try {
          resolved = resolve(aid)
        } catch {
          img.removeAttribute('src')
          return
        }
        if (typeof resolved === 'string') {
          img.setAttribute('src', resolved)
          return
        }
        // nothing is shown (rather than the unresolvable reference) until the URL is known
        img.removeAttribute('src')
        resolved.then(
          (url) => {
            if (current === generation) img.setAttribute('src', url)
          },
          () => {
            if (current === generation) img.setAttribute('data-load-error', 'true')
          },
        )
      }

      const applyDisplayAttributes = () => {
        for (const name of DISPLAY_ATTRIBUTES) {
          const value: unknown = node.attrs[name]
          if (value == null || value === '') img.removeAttribute(name)
          else img.setAttribute(name, String(value))
        }
      }

      applyDisplayAttributes()
      applySrc(node.attrs.src)

      return {
        dom: img,
        update: (updated) => {
          if (updated.type !== node.type) return false
          const srcChanged = updated.attrs.src !== node.attrs.src
          node = updated
          applyDisplayAttributes()
          // re-resolving an unchanged src would refetch (and flicker) for nothing
          if (srcChanged) applySrc(node.attrs.src)
          return true
        },
        destroy: () => {
          // invalidates any resolution still in flight
          generation++
        },
      }
    }
  },
})
