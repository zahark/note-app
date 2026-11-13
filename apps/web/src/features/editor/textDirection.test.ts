import { act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { destroyEditors, doc, makeEditor } from '@/test/editor'

const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

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

    expect(JSON.stringify(editor.getJSON())).not.toContain('"dir"')
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
