import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { ExternalLinkIcon, PencilIcon, UnlinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  applyLinkHref,
  dismissLinkPopover,
  LINK_POPOVER_KEY,
  linkReference,
  openableUrl,
  openLink,
  removeLink,
  shouldShowLinkPopover,
} from './links'

// keep the editor's selection and focus: a button press must not blur the editor first
const keepEditorFocus = (event: { preventDefault: () => void }) => event.preventDefault()

/**
 * The owner editor's link popover: while the cursor is in a link it shows the URL with Open (new
 * tab, http/https/mailto only), Edit (inline; Enter saves, Escape cancels, empty removes the link)
 * and Remove (keeps the text). It never takes focus by itself; Tab from the editor reaches it.
 */
export function LinkPopover({ editor }: { editor: Editor }) {
  const href = useEditorState({
    editor,
    selector: ({ editor: e }) => (e.isActive('link') ? ((e.getAttributes('link').href as string | undefined) ?? '') : null),
  })
  const [draft, setDraft] = useState<string | null>(null)
  const getReferencedVirtualElement = useCallback(() => linkReference(editor), [editor])
  const options = useMemo(() => ({ placement: 'bottom-start' as const, onHide: () => setDraft(null) }), [])

  const menu = useRef<HTMLDivElement>(null)

  // after an edit or Escape the editor gets focus back at once (the `focus` command waits a frame)
  const save = () => {
    if (draft !== null) applyLinkHref(editor, draft)
    editor.view.focus()
    setDraft(null)
  }
  // native listeners on the menu element, so they also cover it when it has focus itself
  useEffect(() => {
    const element = menu.current
    if (!element) return
    // the plugin makes the menu element itself a tab stop; Tab should land on its first button
    element.tabIndex = -1
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      editor.view.focus()
      if (draft !== null) setDraft(null)
      else dismissLinkPopover(editor.view)
    }
    // focus leaving for somewhere other than the editor hides it (the editor's own blur does the same);
    // checked once focus has settled, since swapping the buttons for the URL field briefly drops it
    const onFocusOut = () => {
      window.setTimeout(() => {
        if (editor.isDestroyed || element.contains(document.activeElement) || editor.view.hasFocus()) return
        dismissLinkPopover(editor.view)
      })
    }
    element.addEventListener('keydown', onKeyDown)
    element.addEventListener('focusout', onFocusOut)
    return () => {
      element.removeEventListener('keydown', onKeyDown)
      element.removeEventListener('focusout', onFocusOut)
    }
  }, [editor, draft])

  return (
    <BubbleMenu
      editor={editor}
      pluginKey={LINK_POPOVER_KEY}
      shouldShow={shouldShowLinkPopover}
      getReferencedVirtualElement={getReferencedVirtualElement}
      options={options}
      ref={menu}
      role="group"
      aria-label="Link actions"
      className="z-50 flex max-w-[calc(100vw-2rem)] items-center gap-1 rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md"
    >
      {draft === null ? (
        <>
          <span className="max-w-64 truncate px-1.5 text-muted-foreground" title={href ?? undefined}>
            {href}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={openableUrl(href) === null}
            onMouseDown={keepEditorFocus}
            onClick={() => openLink(href)}
          >
            <ExternalLinkIcon />
            Open
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(href ?? '')}>
            <PencilIcon />
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onMouseDown={keepEditorFocus}
            onClick={() => removeLink(editor)}
          >
            <UnlinkIcon />
            Remove
          </Button>
        </>
      ) : (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <Input
            aria-label="Link URL"
            className="h-7 w-64"
            autoFocus
            value={draft}
            placeholder="https://"
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" variant="ghost" size="sm">
            Save
          </Button>
        </form>
      )}
    </BubbleMenu>
  )
}
