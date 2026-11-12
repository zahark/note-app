import type { JSONContent } from '@tiptap/core'
import { act, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { destroyEditors, doc, makeEditor } from '@/test/editor'
import { applyLinkHref, normalizeHref, openableUrl, openLink, removeLink } from './links'

const HREF = 'https://example.com/docs'

/** A paragraph "See docs here" whose "docs" links to `href`. */
const linked = (href = HREF): JSONContent =>
  doc({
    type: 'paragraph',
    content: [
      { type: 'text', text: 'See ' },
      { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href } }] },
      { type: 'text', text: ' here' },
    ],
  })

/** Every link href in a TipTap JSON document, with its text. */
function links(json: JSONContent): [string, unknown][] {
  const out: [string, unknown][] = []
  const walk = (node: JSONContent) => {
    const link = node.marks?.find((mark) => mark.type === 'link')
    if (link) out.push([node.text ?? '', link.attrs?.href])
    node.content?.forEach(walk)
  }
  walk(json)
  return out
}

let open: ReturnType<typeof vi.fn>
beforeEach(() => {
  open = vi.fn(() => null)
  vi.stubGlobal('open', open)
})
afterEach(async () => {
  await destroyEditors()
})

describe('openableUrl / openLink', () => {
  it('accepts absolute http, https and mailto URLs only', () => {
    expect(openableUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(openableUrl('http://127.0.0.1:3100/x')).toBe('http://127.0.0.1:3100/x')
    expect(openableUrl('mailto:me@example.com')).toBe('mailto:me@example.com')
    for (const href of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'example.com', '/relative', '', null, undefined]) {
      expect(openableUrl(href), String(href)).toBeNull()
    }
  })

  it('opens in a new tab with noopener,noreferrer, and refuses anything else', () => {
    expect(openLink(HREF)).toBe(true)
    expect(open).toHaveBeenCalledWith(HREF, '_blank', 'noopener,noreferrer')
    open.mockClear()
    expect(openLink('javascript:alert(1)')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('normalizeHref', () => {
  it('trims, keeps a scheme and adds https:// to a bare host', () => {
    expect(normalizeHref('  https://a.example/x  ')).toBe('https://a.example/x')
    expect(normalizeHref('mailto:me@example.com')).toBe('mailto:me@example.com')
    expect(normalizeHref('example.com/path')).toBe('https://example.com/path')
    expect(normalizeHref('   ')).toBe('')
  })
})

describe('applyLinkHref / removeLink', () => {
  it('changes the whole link under the cursor; an empty value removes it and keeps the text', () => {
    const editor = makeEditor(linked())
    act(() => {
      editor.commands.setTextSelection(7) // inside "docs"
      applyLinkHref(editor, 'example.org')
    })
    expect(links(editor.getJSON())).toEqual([['docs', 'https://example.org']])

    act(() => {
      editor.commands.setTextSelection(7)
      applyLinkHref(editor, '  ')
    })
    expect(links(editor.getJSON())).toEqual([])
    expect(editor.getText()).toBe('See docs here')
  })

  it('removeLink unsets the link and keeps the text', () => {
    const editor = makeEditor(linked())
    act(() => {
      editor.commands.setTextSelection(7)
      removeLink(editor)
    })
    expect(links(editor.getJSON())).toEqual([])
    expect(editor.getText()).toBe('See docs here')
  })
})

describe('Cmd/Ctrl+click on a link', () => {
  const anchorOf = (editor: ReturnType<typeof makeEditor>) => editor.view.dom.querySelector('a')!

  it('opens the link in a new tab with Cmd or Ctrl; a plain click does not', () => {
    const editor = makeEditor(linked())
    const anchor = anchorOf(editor)

    const plain = fireEvent.click(anchor)
    expect(plain).toBe(true) // default not prevented, nothing opened
    expect(open).not.toHaveBeenCalled()

    expect(fireEvent.mouseDown(anchor, { metaKey: true })).toBe(false)
    expect(fireEvent.click(anchor, { metaKey: true })).toBe(false)
    expect(open).toHaveBeenCalledWith(HREF, '_blank', 'noopener,noreferrer')

    open.mockClear()
    fireEvent.click(anchor, { ctrlKey: true })
    expect(open).toHaveBeenCalledWith(HREF, '_blank', 'noopener,noreferrer')
  })

  it('never opens a javascript: link, and does nothing in a read-only editor', () => {
    const unsafe = makeEditor(linked('javascript:alert(1)'))
    fireEvent.click(anchorOf(unsafe), { metaKey: true })
    expect(open).not.toHaveBeenCalled()

    const readOnly = makeEditor(linked(), { editable: false })
    // the browser follows the link's own target="_blank" there
    expect(fireEvent.click(anchorOf(readOnly), { metaKey: true })).toBe(true)
    expect(open).not.toHaveBeenCalled()
  })
})
