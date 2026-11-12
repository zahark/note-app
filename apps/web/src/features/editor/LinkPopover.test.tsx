import type { Editor, JSONContent } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { doc, ownerResolver } from '@/test/editor'
import { editorExtensions } from './extensions'
import { LinkPopover } from './LinkPopover'

const HREF = 'https://example.com/a/rather/long/path/to/some/documentation?with=query'

/** "See docs here" with "docs" (positions 5–9) linking to `href`. */
const linked = (href = HREF): JSONContent =>
  doc({
    type: 'paragraph',
    content: [
      { type: 'text', text: 'See ' },
      { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href } }] },
      { type: 'text', text: ' here' },
    ],
  })
const INSIDE_LINK = 7
const OUTSIDE_LINK = 2

/** The owner's editor (note schema) with the link popover, as `NotePane` renders them. */
function Harness({ content, editable = true }: { content: JSONContent; editable?: boolean }) {
  const editor = useEditor({
    editable,
    extensions: editorExtensions({ resolveAttachment: ownerResolver, downloadAttachment: () => {} }),
    content,
    editorProps: { attributes: { 'aria-label': 'Note content' } },
  })
  return (
    <>
      <EditorContent editor={editor} />
      <LinkPopover editor={editor} />
      <button type="button">Elsewhere</button>
    </>
  )
}

function renderEditor(content = linked(), editable = true): Editor {
  render(<Harness content={content} editable={editable} />)
  return (screen.getByLabelText('Note content') as HTMLElement & { editor: Editor }).editor
}

/** Focuses the editor and puts the cursor at `pos`, as a click there would. */
function placeCursor(editor: Editor, pos: number) {
  act(() => {
    editor.view.focus()
    editor.commands.setTextSelection(pos)
  })
}

const popover = () => screen.queryByRole('group', { name: 'Link actions' })
const findPopover = () => screen.findByRole('group', { name: 'Link actions' })

/** Every link href in the editor with its text. */
function links(editor: Editor): [string, unknown][] {
  const out: [string, unknown][] = []
  editor.state.doc.descendants((node) => {
    const link = node.marks.find((mark) => mark.type.name === 'link')
    if (link) out.push([node.text ?? '', link.attrs.href])
  })
  return out
}

let open: ReturnType<typeof vi.fn>
beforeEach(() => {
  open = vi.fn(() => null)
  vi.stubGlobal('open', open)
})

describe('link popover', () => {
  it('appears with the URL while the cursor is in a link and hides when it leaves', async () => {
    const editor = renderEditor()
    expect(popover()).not.toBeInTheDocument()

    placeCursor(editor, INSIDE_LINK)
    const menu = await findPopover()
    const url = screen.getByText(HREF)
    expect(url).toHaveAttribute('title', HREF)
    expect(url).toHaveClass('truncate')
    expect(menu).toContainElement(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
    // it does not take the focus from the editor
    expect(editor.view.hasFocus()).toBe(true)

    placeCursor(editor, OUTSIDE_LINK)
    await waitFor(() => expect(popover()).not.toBeInTheDocument())
  })

  it('Open opens the link in a new tab with noopener,noreferrer', async () => {
    const editor = renderEditor()
    placeCursor(editor, INSIDE_LINK)
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }))
    expect(open).toHaveBeenCalledWith(HREF, '_blank', 'noopener,noreferrer')
  })

  it('Open is disabled for a javascript: link', async () => {
    const editor = renderEditor(linked('javascript:alert(1)'))
    placeCursor(editor, INSIDE_LINK)
    expect(await screen.findByRole('button', { name: 'Open' })).toBeDisabled()
    expect(open).not.toHaveBeenCalled()
  })

  it('Edit changes the URL with Enter; Escape cancels; an empty URL removes the link', async () => {
    const user = userEvent.setup()
    const editor = renderEditor()
    placeCursor(editor, INSIDE_LINK)
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    const input = screen.getByRole('textbox', { name: 'Link URL' })
    expect(input).toHaveFocus()
    expect(input).toHaveValue(HREF)
    await user.clear(input)
    await user.type(input, 'example.org/new{Enter}')
    expect(links(editor)).toEqual([['docs', 'https://example.org/new']])
    // back to the buttons, showing the new URL, with the editor focused again
    expect(await screen.findByText('https://example.org/new')).toBeInTheDocument()
    expect(editor.view.hasFocus()).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByRole('textbox', { name: 'Link URL' }), 'zzz{Escape}')
    expect(links(editor)).toEqual([['docs', 'https://example.org/new']])
    expect(screen.queryByRole('textbox', { name: 'Link URL' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByRole('textbox', { name: 'Link URL' }))
    await user.keyboard('{Enter}')
    expect(links(editor)).toEqual([])
    expect(editor.getText()).toBe('See docs here')
    await waitFor(() => expect(popover()).not.toBeInTheDocument())
  })

  it('Remove unsets the link and keeps the text', async () => {
    const editor = renderEditor()
    placeCursor(editor, INSIDE_LINK)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(links(editor)).toEqual([])
    expect(editor.getText()).toBe('See docs here')
    await waitFor(() => expect(popover()).not.toBeInTheDocument())
  })

  it('Escape hides it until the cursor moves; it is reachable with Tab', async () => {
    const user = userEvent.setup()
    const editor = renderEditor()
    placeCursor(editor, INSIDE_LINK)
    await findPopover()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(popover()).not.toBeInTheDocument())

    placeCursor(editor, INSIDE_LINK + 1)
    await findPopover()
    // Tab moves into the popover (focus there keeps it open), Escape there returns to the editor
    // (jsdom also stops on the link inside the editor, which browsers skip in an editable area)
    for (let i = 0; i < 3 && !popover()!.contains(document.activeElement); i++) await user.tab()
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus()
    expect(popover()).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(popover()).not.toBeInTheDocument())
    expect(editor.view.hasFocus()).toBe(true)
  })

  it('hides when the focus moves elsewhere', async () => {
    const editor = renderEditor()
    placeCursor(editor, INSIDE_LINK)
    await findPopover()
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }))
    await waitFor(() => expect(popover()).not.toBeInTheDocument())
  })

  it('hides for a selection reaching beyond the link', async () => {
    const editor = renderEditor()
    placeCursor(editor, INSIDE_LINK)
    await findPopover()
    act(() => {
      editor.commands.setTextSelection({ from: OUTSIDE_LINK, to: INSIDE_LINK })
    })
    await waitFor(() => expect(popover()).not.toBeInTheDocument())
  })

  it('never shows in a read-only editor', async () => {
    const editor = renderEditor(linked(), false)
    placeCursor(editor, INSIDE_LINK)
    // give a (debounced) show the time it would take
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(popover()).not.toBeInTheDocument()
  })
})
