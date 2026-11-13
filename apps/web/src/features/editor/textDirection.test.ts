import { act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import { destroyEditors, doc, makeEditor } from '@/test/editor'
import { forcedTextDirection, toggleTextDirection } from './textDirection'

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

/** Every forced `dir` in a TipTap JSON document, with the node type and its text. */
function storedDirections(json: JSONContent): [string, string, unknown][] {
  const out: [string, string, unknown][] = []
  const text = (node: JSONContent): string => node.text ?? (node.content ?? []).map(text).join('')
  const walk = (node: JSONContent) => {
    if (node.attrs?.dir != null) out.push([node.type ?? '', text(node), node.attrs.dir])
    node.content?.forEach(walk)
  }
  walk(json)
  return out
}

afterEach(async () => {
  await destroyEditors()
})

describe('AutoTextDirection', () => {
  it('gives every text block dir="auto" on screen, except code blocks, and stores nothing', () => {
    const content = doc(
      paragraph('שלום עולם'),
      paragraph('Hello'),
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'כותרת' }] },
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph('פריט')] }],
      },
      { type: 'blockquote', content: [paragraph('ציטוט')] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'const a = 1' }] },
    )
    const editor = makeEditor(content)
    const dom = editor.view.dom

    for (const selector of ['p', 'h2', 'ul', 'li', 'blockquote']) {
      const elements = Array.from(dom.querySelectorAll(selector))
      expect(elements.length, selector).toBeGreaterThan(0)
      for (const element of elements) expect(element.getAttribute('dir'), selector).toBe('auto')
    }
    expect(dom.querySelector('pre')?.hasAttribute('dir')).toBe(false)
    expect(dom.getAttribute('dir')).toBeNull() // the editor itself keeps the page's direction

    expect(storedDirections(editor.getJSON())).toEqual([])
  })

  it('marks blocks typed later too', () => {
    const editor = makeEditor(doc(paragraph('Hello')))
    act(() => {
      editor.commands.setTextSelection(6)
      editor.commands.splitBlock()
      editor.commands.insertContent('שלום')
    })
    const paragraphs = Array.from(editor.view.dom.querySelectorAll('p'))
    expect(paragraphs.map((p) => [p.textContent, p.getAttribute('dir')])).toEqual([
      ['Hello', 'auto'],
      ['שלום', 'auto'],
    ])
  })
})

describe('forcing a direction (toolbar buttons)', () => {
  it('forces the paragraph at the cursor, a second press goes back to automatic', () => {
    const editor = makeEditor(doc(paragraph('GPX של המסלול'), paragraph('Hello')))
    act(() => {
      editor.commands.setTextSelection(2)
      toggleTextDirection(editor, 'rtl')
    })
    expect(storedDirections(editor.getJSON())).toEqual([['paragraph', 'GPX של המסלול', 'rtl']])
    expect(forcedTextDirection(editor)).toBe('rtl')
    const [first, second] = Array.from(editor.view.dom.querySelectorAll('p'))
    expect(first?.getAttribute('dir')).toBe('rtl')
    expect(second?.getAttribute('dir')).toBe('auto')

    act(() => toggleTextDirection(editor, 'ltr'))
    expect(storedDirections(editor.getJSON())).toEqual([['paragraph', 'GPX של המסלול', 'ltr']])

    act(() => toggleTextDirection(editor, 'ltr'))
    expect(storedDirections(editor.getJSON())).toEqual([])
    expect(forcedTextDirection(editor)).toBeNull()
    expect(editor.view.dom.querySelector('p')?.getAttribute('dir')).toBe('auto')
  })

  it('covers every paragraph in the selection, and Enter keeps the direction', () => {
    const editor = makeEditor(doc(paragraph('one'), paragraph('two'), paragraph('three')))
    act(() => {
      editor.commands.setTextSelection({ from: 2, to: 8 }) // "one" into "two"
      toggleTextDirection(editor, 'rtl')
    })
    expect(storedDirections(editor.getJSON())).toEqual([
      ['paragraph', 'one', 'rtl'],
      ['paragraph', 'two', 'rtl'],
    ])
    act(() => {
      editor.commands.setTextSelection(4) // end of "one"
      editor.commands.splitBlock()
    })
    expect(storedDirections(editor.getJSON())).toEqual([
      ['paragraph', 'one', 'rtl'],
      ['paragraph', '', 'rtl'],
      ['paragraph', 'two', 'rtl'],
    ])
  })

  it('in a list, forces the whole list item; in a code block it does nothing', () => {
    const editor = makeEditor(
      doc(
        { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Jeep ג׳יפ')] }] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'x' }] },
      ),
    )
    act(() => {
      editor.commands.setTextSelection(4)
      toggleTextDirection(editor, 'rtl')
    })
    expect(storedDirections(editor.getJSON())).toEqual([['listItem', 'Jeep ג׳יפ', 'rtl']])
    expect(editor.view.dom.querySelector('li')?.getAttribute('dir')).toBe('rtl')

    const codeStart = editor.state.doc.firstChild!.nodeSize + 1
    act(() => {
      editor.commands.setTextSelection(codeStart + 1)
    })
    expect(editor.commands.setTextDirection('rtl')).toBe(false)
  })

  it('shows a stored direction in the read-only shared view, and ignores unknown values', () => {
    const shared = makeEditor(
      doc(
        { type: 'paragraph', attrs: { dir: 'rtl' }, content: [{ type: 'text', text: 'GPX של המסלול' }] },
        { type: 'paragraph', attrs: { dir: 'sideways' }, content: [{ type: 'text', text: 'x' }] },
      ),
      { editable: false },
    )
    const [first, second] = Array.from(shared.view.dom.querySelectorAll('p'))
    expect(first?.getAttribute('dir')).toBe('rtl')
    expect(second?.getAttribute('dir')).toBe('auto')
  })
})
