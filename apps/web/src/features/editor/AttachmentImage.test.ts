import { Editor, type JSONContent } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachmentSrc, parseAttachmentSrc, type AttachmentResolver } from './AttachmentImage'
import { editorExtensions } from './extensions'

const AID = '0b4c2f7e-1d2a-4c3b-9e8f-0123456789ab'
const OTHER_AID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const ownerResolver: AttachmentResolver = (aid) => `/api/attachments/${aid}`

const editors: Editor[] = []

function makeEditor(content: JSONContent | undefined, resolveAttachment: AttachmentResolver | null = ownerResolver) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: editorExtensions({ resolveAttachment }), content })
  editors.push(editor)
  return editor
}

afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
  document.body.innerHTML = ''
})

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const image = (src: string): JSONContent => ({ type: 'image', attrs: { src } })
const paragraph = (text?: string): JSONContent => ({
  type: 'paragraph',
  ...(text ? { content: [{ type: 'text', text }] } : {}),
})

/** Every image src in a TipTap JSON document. */
function imageSrcs(json: JSONContent): string[] {
  const out: string[] = []
  const walk = (node: JSONContent) => {
    if (node.type === 'image') out.push(String(node.attrs?.src))
    node.content?.forEach(walk)
  }
  walk(json)
  return out
}

/** A minimal DataTransfer stand-in: ProseMirror only uses get/set/clearData on copy and paste. */
function fakeClipboard() {
  const data = new Map<string, string>()
  return {
    data,
    clipboardData: {
      getData: (type: string) => data.get(type) ?? '',
      setData: (type: string, value: string) => void data.set(type, value),
      clearData: () => data.clear(),
      files: [] as File[],
      items: [] as DataTransferItem[],
      types: [] as string[],
    },
  }
}

function clipboardEvent(type: 'copy' | 'cut' | 'paste', clipboardData: unknown): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: clipboardData })
  return event
}

/** Selects the first image node and copies it the way the browser does (a `copy` event on the editor). */
function copyFirstImage(editor: Editor): Map<string, string> {
  let pos = -1
  editor.state.doc.descendants((node, p) => {
    if (pos < 0 && node.type.name === 'image') pos = p
  })
  expect(pos).toBeGreaterThanOrEqual(0)
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)))
  const { data, clipboardData } = fakeClipboard()
  editor.view.dom.dispatchEvent(clipboardEvent('copy', clipboardData))
  return data
}

/** Puts the cursor at the end of the document and pastes the clipboard contents. */
function pasteAtEnd(editor: Editor, data: Map<string, string>) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)))
  const { data: target, clipboardData } = fakeClipboard()
  for (const [type, value] of data) target.set(type, value)
  editor.view.dom.dispatchEvent(clipboardEvent('paste', clipboardData))
}

describe('parseAttachmentSrc', () => {
  it('extracts the id from attachment://<uuid> only', () => {
    expect(parseAttachmentSrc(attachmentSrc(AID))).toBe(AID)
    expect(parseAttachmentSrc(`/api/attachments/${AID}`)).toBeNull()
    expect(parseAttachmentSrc('attachment://not-a-uuid')).toBeNull()
    expect(parseAttachmentSrc('https://example.com/a.png')).toBeNull()
    expect(parseAttachmentSrc(null)).toBeNull()
  })
})

describe('AttachmentImage node view', () => {
  it('resolves attachment://<aid> through the resolver for display while getJSON keeps the reference', () => {
    const resolver = vi.fn(ownerResolver)
    const editor = makeEditor(doc(image(attachmentSrc(AID))), resolver)

    const img = editor.view.dom.querySelector('img')!
    expect(resolver).toHaveBeenCalledWith(AID)
    expect(img.getAttribute('src')).toBe(`/api/attachments/${AID}`)
    expect(img.getAttribute('data-attachment-id')).toBe(AID)
    expect(imageSrcs(editor.getJSON())).toEqual([attachmentSrc(AID)])
    expect(JSON.stringify(editor.getJSON())).not.toContain('/api/attachments')
  })

  it('applies an async resolution (e.g. a blob URL) once it settles', async () => {
    let release!: (url: string) => void
    const resolver = vi.fn(() => new Promise<string>((resolve) => (release = resolve)))
    const editor = makeEditor(doc(image(attachmentSrc(AID))), resolver)

    const img = editor.view.dom.querySelector('img')!
    expect(img.hasAttribute('src')).toBe(false)
    release('blob:http://localhost/123')
    await vi.waitFor(() => expect(img.getAttribute('src')).toBe('blob:http://localhost/123'))
    expect(imageSrcs(editor.getJSON())).toEqual([attachmentSrc(AID)])
  })

  it('re-resolves when the src changes, ignoring a stale resolution', async () => {
    const pending: Record<string, (url: string) => void> = {}
    const resolver = (aid: string) => new Promise<string>((resolve) => (pending[aid] = resolve))
    const editor = makeEditor(doc(image(attachmentSrc(AID))), resolver)
    const img = editor.view.dom.querySelector('img')!

    editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { src: attachmentSrc(OTHER_AID) }))
    pending[OTHER_AID]!('blob:new')
    pending[AID]!('blob:old')
    await vi.waitFor(() => expect(img.getAttribute('src')).toBe('blob:new'))
    await Promise.resolve()
    expect(img.getAttribute('src')).toBe('blob:new')
  })

  it('never loads a non-attachment src stored in content (no request to an outside URL)', () => {
    const resolver = vi.fn(ownerResolver)
    const editor = makeEditor(doc(image('https://example.com/a.png')), resolver)

    const img = editor.view.dom.querySelector('img')!
    expect(img.hasAttribute('src')).toBe(false)
    expect(img.hasAttribute('data-attachment-id')).toBe(false)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('shows the stored src as-is when no resolver is configured', () => {
    const editor = makeEditor(doc(image(attachmentSrc(AID))), null)
    expect(editor.view.dom.querySelector('img')!.getAttribute('src')).toBe(attachmentSrc(AID))
  })
})

describe('AttachmentImage HTML (clipboard)', () => {
  it('renderHTML keeps attachment://<aid> and data-attachment-id, never the resolved URL', () => {
    const editor = makeEditor(doc(image(attachmentSrc(AID))))
    const html = editor.getHTML()
    expect(html).toContain(`src="${attachmentSrc(AID)}"`)
    expect(html).toContain(`data-attachment-id="${AID}"`)
    expect(html).not.toContain('/api/attachments')
  })

  it('copying an image puts the reference, not the resolved URL, on the clipboard', () => {
    const editor = makeEditor(doc(paragraph('before'), image(attachmentSrc(AID)), paragraph('after')))
    const data = copyFirstImage(editor)

    const html = data.get('text/html')!
    expect(html).toContain(`src="${attachmentSrc(AID)}"`)
    expect(html).toContain(`data-attachment-id="${AID}"`)
    expect(html).not.toContain('/api/attachments')
  })

  it('copy + paste within the same editor yields attachment://<aid> in getJSON', () => {
    const editor = makeEditor(doc(image(attachmentSrc(AID)), paragraph('end')))
    pasteAtEnd(editor, copyFirstImage(editor))

    expect(imageSrcs(editor.getJSON())).toEqual([attachmentSrc(AID), attachmentSrc(AID)])
    const imgs = editor.view.dom.querySelectorAll('img')
    expect(imgs).toHaveLength(2)
    imgs.forEach((img) => expect(img.getAttribute('src')).toBe(`/api/attachments/${AID}`))
  })

  it('copy from one editor + paste into a second editor yields attachment://<aid> in getJSON', () => {
    const source = makeEditor(doc(image(attachmentSrc(AID))))
    const target = makeEditor(doc(paragraph('target')))
    pasteAtEnd(target, copyFirstImage(source))

    expect(imageSrcs(target.getJSON())).toEqual([attachmentSrc(AID)])
    expect(target.view.dom.querySelector('img')!.getAttribute('src')).toBe(`/api/attachments/${AID}`)
  })

  it('cut + paste moves the reference', () => {
    const editor = makeEditor(doc(paragraph('a'), image(attachmentSrc(AID)), paragraph('b')))
    let pos = -1
    editor.state.doc.descendants((node, p) => {
      if (node.type.name === 'image') pos = p
    })
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)))
    const { data, clipboardData } = fakeClipboard()
    editor.view.dom.dispatchEvent(clipboardEvent('cut', clipboardData))
    expect(imageSrcs(editor.getJSON())).toEqual([])

    pasteAtEnd(editor, data)
    expect(imageSrcs(editor.getJSON())).toEqual([attachmentSrc(AID)])
  })

  it('pasted HTML with data-attachment-id is read back as the reference even if its src was resolved', () => {
    const editor = makeEditor(doc(paragraph('x')))
    const data = new Map([['text/html', `<img src="/api/attachments/${AID}" data-attachment-id="${AID}">`]])
    pasteAtEnd(editor, data)
    expect(imageSrcs(editor.getJSON())).toEqual([attachmentSrc(AID)])
  })

  it('pasted HTML with an outside or data: image drops the image and keeps the text', () => {
    const editor = makeEditor(doc(paragraph('x')))
    pasteAtEnd(
      editor,
      new Map([
        [
          'text/html',
          '<p>kept</p><img src="https://example.com/b.png"><img src="data:image/png;base64,iVBORw0KGgo=">' +
            '<img src="https://example.com/c.png" data-attachment-id="not-a-uuid">',
        ],
      ]),
    )
    expect(imageSrcs(editor.getJSON())).toEqual([])
    expect(editor.getText()).toContain('kept')
  })

  it('pasted HTML with an attachment:// src (no data-attachment-id) is read as the reference', () => {
    const editor = makeEditor(doc(paragraph('x')))
    pasteAtEnd(editor, new Map([['text/html', `<img src="${attachmentSrc(OTHER_AID)}">`]]))
    expect(imageSrcs(editor.getJSON())).toEqual([attachmentSrc(OTHER_AID)])
  })
})
