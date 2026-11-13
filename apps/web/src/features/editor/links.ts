import { Extension, getMarkRange, isMarkActive, posToDOMRect, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/** The only link protocols the editor ever opens (Open, Cmd/Ctrl+click); anything else (`javascript:`, `data:`, …) is refused. */
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** The absolute URL `href` opens, or null when it is not an absolute http(s)/mailto URL. */
export function openableUrl(href: string | null | undefined): string | null {
  if (!href) return null
  try {
    const url = new URL(href)
    return OPENABLE_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/** Opens `href` in a new tab without giving it access to this page; returns false (and opens nothing) for a refused URL. */
export function openLink(href: string | null | undefined): boolean {
  const url = openableUrl(href)
  if (url === null) return false
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}

/** A typed link target as stored: trimmed, and `https://` added when it names no scheme (`example.com`). */
export function normalizeHref(input: string): string {
  const href = input.trim()
  if (href === '' || /^[a-z][a-z\d+.-]*:/i.test(href)) return href
  return `https://${href}`
}

/**
 * Sets the link under the cursor (the whole link, or the selection when there is none) to `input`;
 * an empty value removes the link and keeps its text. With only a cursor outside any link, the typed
 * address is inserted as the link's text (a bare `setLink` there would only arm a stored mark and
 * show nothing). Shared by the toolbar's Link button and the link popover's Edit.
 */
export function applyLinkHref(editor: Editor, input: string): void {
  const href = normalizeHref(input)
  if (href !== '' && editor.state.selection.empty && !editor.isActive('link')) {
    editor
      .chain()
      .focus()
      .insertContent({ type: 'text', text: input.trim(), marks: [{ type: 'link', attrs: { href } }] })
      .unsetMark('link') // typing on after it does not extend the link
      .run()
    return
  }
  const chain = editor.chain().focus().extendMarkRange('link')
  if (href === '') chain.unsetLink().run()
  else chain.setLink({ href }).run()
}

/** Removes the link under the cursor, keeping its text. */
export function removeLink(editor: Editor): void {
  editor.chain().focus().extendMarkRange('link').unsetLink().run()
}

/** The BubbleMenu plugin key of the owner editor's link popover (`LinkPopover`). */
export const LINK_POPOVER_KEY = new PluginKey('linkPopover')

/** Whether the popover was dismissed (Escape) for the current selection; any selection or document change clears it. */
const dismissedKey = new PluginKey<boolean>('linkPopoverDismissed')

/** Hides the link popover until the selection or the document changes. */
export function dismissLinkPopover(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(dismissedKey, true).setMeta(LINK_POPOVER_KEY, 'hide'))
}

/**
 * Whether the link popover belongs on screen: an editable editor (or the popover itself) has focus,
 * the whole selection is inside one link (a collapsed cursor in a link, or a selection within it),
 * and it was not dismissed.
 */
export function shouldShowLinkPopover({
  editor,
  view,
  element,
  state,
}: {
  editor: Editor
  view: EditorView
  element: HTMLElement
  state: EditorState
}): boolean {
  if (!editor.isEditable || dismissedKey.getState(state)) return false
  if (!view.hasFocus() && !element.contains(document.activeElement)) return false
  const link = state.schema.marks.link
  return link !== undefined && isMarkActive(state, link)
}

/** A floating-ui reference for the whole link under the cursor (null: fall back to the selection). */
export function linkReference(editor: Editor): { getBoundingClientRect: () => DOMRect; getClientRects: () => DOMRect[] } | null {
  const { state, view } = editor
  const link = state.schema.marks.link
  const range = link && getMarkRange(state.selection.$from, link)
  if (!range) return null
  const rect = posToDOMRect(view, range.from, range.to)
  return { getBoundingClientRect: () => rect, getClientRects: () => [rect] }
}

/** The `href` of the link a Cmd/Ctrl+click (primary button) in an editable editor lands on, else null. */
function modClickedHref(view: EditorView, event: MouseEvent): string | null {
  if (!view.editable || event.button !== 0 || !(event.metaKey || event.ctrlKey)) return null
  const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
  return anchor && view.dom.contains(anchor) ? anchor.getAttribute('href') : null
}

/**
 * Link behaviour of the editable editor: Cmd+click (macOS) / Ctrl+click opens the link in a new tab
 * (only http/https/mailto, see `openLink`), and Escape dismisses the link popover. The read-only
 * shared view is left alone: there a plain click follows the link's own `target="_blank"`.
 */
export const LinkShortcuts = Extension.create({
  name: 'linkShortcuts',

  addProseMirrorPlugins() {
    return [
      new Plugin<boolean>({
        key: dismissedKey,
        state: {
          init: () => false,
          apply: (tr, dismissed) =>
            (tr.getMeta(dismissedKey) as boolean | undefined) ?? (tr.selectionSet || tr.docChanged ? false : dismissed),
        },
        props: {
          handleKeyDown: (view, event) => {
            const link = view.state.schema.marks.link
            if (event.key !== 'Escape' || !link || dismissedKey.getState(view.state) || !isMarkActive(view.state, link)) {
              return false
            }
            dismissLinkPopover(view)
            return true
          },
          handleDOMEvents: {
            // keep ProseMirror from turning the modified click into a node selection
            mousedown: (view, event) => {
              if (modClickedHref(view, event) === null) return false
              event.preventDefault()
              return true
            },
            click: (view, event) => {
              const href = modClickedHref(view, event)
              if (href === null) return false
              event.preventDefault()
              openLink(href)
              return true
            },
          },
        },
      }),
    ]
  },
})
