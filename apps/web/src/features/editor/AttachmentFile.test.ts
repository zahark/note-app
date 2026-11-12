import { Editor, type JSONContent } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileDisplayName, formatFileSize, type AttachmentDownloader } from './AttachmentFile'
import { attachmentSrc } from './AttachmentImage'
import { editorExtensions } from './extensions'
import { copyNodeAt, firstNodePos, pasteAtEnd } from '@/test/clipboard'

const AID = '0b4c2f7e-1d2a-4c3b-9e8f-0123456789ab'
const OTHER_AID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const ownerResolver = (aid: string) => `/api/attachments/${aid}`

const editors: Editor[] = []

function makeEditor(
  content: JSONContent | undefined,
  { downloadAttachment = null, editable = true }: { downloadAttachment?: AttachmentDownloader | null; editable?: boolean } = {},
) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    editable,
    extensions: editorExtensions({ resolveAttachment: ownerResolver, downloadAttachment }),
    content,
  })
  editors.push(editor)
  return editor
}

afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
  document.body.innerHTML = ''
})

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const paragraph = (text?: string): JSONContent => ({
  type: 'paragraph',
  ...(text ? { content: [{ type: 'text', text }] } : {}),
})
const file = (src: string, attrs: { name?: string | null; size?: number | null; kind?: string | null } = {}): JSONContent => ({
  type: 'attachmentFile',
  attrs: { src, name: 'route.gpx', size: 2048, kind: 'gpx', ...attrs },
})

/** Every file node's attrs in a TipTap JSON document. */
function fileNodes(json: JSONContent): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const walk = (node: JSONContent) => {
    if (node.type === 'attachmentFile') out.push(node.attrs ?? {})
    node.content?.forEach(walk)
  }
  walk(json)
  return out
}

function copyFirstFile(editor: Editor): Map<string, string> {
  const pos = firstNodePos(editor, 'attachmentFile')
  expect(pos).toBeGreaterThanOrEqual(0)
  return copyNodeAt(editor, pos)
}

describe('formatFileSize / fileDisplayName', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(25 * 1024 * 1024)).toBe('25.0 MB')
  })

  it('falls back to a name per kind', () => {
    expect(fileDisplayName('a.pdf', 'pdf')).toBe('a.pdf')
    expect(fileDisplayName('', 'pdf')).toBe('document.pdf')
    expect(fileDisplayName(null, 'gpx')).toBe('track.gpx')
    expect(fileDisplayName(undefined, null)).toBe('file')
  })
})

describe('AttachmentFile JSON', () => {
  it('getJSON keeps attachment://<aid> and the name/size/kind attrs', () => {
    const editor = makeEditor(doc(file(attachmentSrc(AID), { name: 'guide.pdf', size: 12345, kind: 'pdf' })))
    expect(fileNodes(editor.getJSON())).toEqual([
      { src: attachmentSrc(AID), name: 'guide.pdf', size: 12345, kind: 'pdf' },
    ])
    expect(JSON.stringify(editor.getJSON())).not.toContain('/api/attachments')
  })

  it('loads the server fixture shape (docWithFiles) as a file node', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'files' }] },
        { type: 'attachmentFile', attrs: { src: `attachment://${AID}`, name: 'file', size: 1, kind: 'pdf' } },
      ],
    })
    expect(fileNodes(editor.getJSON())).toEqual([{ src: attachmentSrc(AID), name: 'file', size: 1, kind: 'pdf' }])
  })
})

describe('AttachmentFile HTML (clipboard)', () => {
  it('renderHTML keeps attachment://<aid> and data-attachment-id, never a resolved URL', () => {
    const editor = makeEditor(doc(file(attachmentSrc(AID))))
    const html = editor.getHTML()
    expect(html).toContain('data-type="attachment-file"')
    expect(html).toContain(`data-src="${attachmentSrc(AID)}"`)
    expect(html).toContain(`data-attachment-id="${AID}"`)
    expect(html).toContain('data-name="route.gpx"')
    expect(html).toContain('data-size="2048"')
    expect(html).toContain('data-kind="gpx"')
    expect(html).not.toContain('/api/attachments')
  })

  it('escapes a name containing markup in the clipboard HTML', () => {
    const editor = makeEditor(doc(file(attachmentSrc(AID), { name: '<img src=x onerror=alert(1)>.gpx' })))
    const html = editor.getHTML()
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.gpx')
  })

  it('copying a file puts the reference, not a resolved URL, on the clipboard', () => {
    const editor = makeEditor(doc(paragraph('before'), file(attachmentSrc(AID)), paragraph('after')))
    const html = copyFirstFile(editor).get('text/html')!
    expect(html).toContain(`data-attachment-id="${AID}"`)
    expect(html).toContain(`data-src="${attachmentSrc(AID)}"`)
    expect(html).not.toContain('/api/attachments')
  })

  it('copy + paste within the same editor keeps the node and its attrs', () => {
    const editor = makeEditor(doc(file(attachmentSrc(AID), { name: 'g.pdf', size: 7, kind: 'pdf' }), paragraph('end')))
    pasteAtEnd(editor, copyFirstFile(editor))

    const expected = { src: attachmentSrc(AID), name: 'g.pdf', size: 7, kind: 'pdf' }
    expect(fileNodes(editor.getJSON())).toEqual([expected, expected])
    expect(editor.view.dom.querySelectorAll('.attachment-file')).toHaveLength(2)
  })

  it('copy from one editor + paste into a second editor keeps the node', () => {
    const source = makeEditor(doc(file(attachmentSrc(AID))))
    const target = makeEditor(doc(paragraph('target')))
    pasteAtEnd(target, copyFirstFile(source))

    expect(fileNodes(target.getJSON())).toEqual([{ src: attachmentSrc(AID), name: 'route.gpx', size: 2048, kind: 'gpx' }])
  })

  it('cut + paste moves the reference', () => {
    const editor = makeEditor(doc(paragraph('a'), file(attachmentSrc(AID)), paragraph('b')))
    const data = copyNodeAt(editor, firstNodePos(editor, 'attachmentFile'), 'cut')
    expect(fileNodes(editor.getJSON())).toEqual([])

    pasteAtEnd(editor, data)
    expect(fileNodes(editor.getJSON()).map((attrs) => attrs.src)).toEqual([attachmentSrc(AID)])
  })

  it('a pasted file block whose data-attachment-id wins over a resolved data-src', () => {
    const editor = makeEditor(doc(paragraph('x')))
    pasteAtEnd(
      editor,
      new Map([
        [
          'text/html',
          `<div data-type="attachment-file" data-src="/api/attachments/${OTHER_AID}" data-attachment-id="${AID}" data-kind="pdf">x</div>`,
        ],
      ]),
    )
    expect(fileNodes(editor.getJSON()).map((attrs) => attrs.src)).toEqual([attachmentSrc(AID)])
  })

  it('a pasted file block without an attachment:// reference is dropped, text included', () => {
    const editor = makeEditor(doc(paragraph('x')))
    pasteAtEnd(
      editor,
      new Map([
        [
          'text/html',
          '<p>kept</p>' +
            '<div data-type="attachment-file" data-src="https://example.com/a.pdf" data-name="evil.pdf">evil.pdf</div>' +
            '<div data-type="attachment-file" data-attachment-id="not-a-uuid" data-name="bad.gpx">bad.gpx</div>',
        ],
      ]),
    )
    expect(fileNodes(editor.getJSON())).toEqual([])
    expect(editor.getText()).toContain('kept')
    expect(editor.getText()).not.toContain('evil.pdf')
    expect(editor.getText()).not.toContain('bad.gpx')
  })

  it('an unknown pasted kind or a bad size is not kept', () => {
    const editor = makeEditor(doc(paragraph('x')))
    pasteAtEnd(
      editor,
      new Map([
        ['text/html', `<div data-type="attachment-file" data-attachment-id="${AID}" data-kind="exe" data-size="-3">f</div>`],
      ]),
    )
    expect(fileNodes(editor.getJSON())).toEqual([{ src: attachmentSrc(AID), name: null, size: null, kind: null }])
  })
})

describe('AttachmentFile node view', () => {
  it('GPX chip shows the name, size and a Download button that calls the download handler', () => {
    const download = vi.fn<AttachmentDownloader>()
    const editor = makeEditor(doc(file(attachmentSrc(AID), { name: 'Ridge loop.gpx', size: 1536 })), {
      downloadAttachment: download,
    })

    const chip = editor.view.dom.querySelector<HTMLElement>('.attachment-file')!
    expect(chip.getAttribute('data-attachment-id')).toBe(AID)
    expect(chip.getAttribute('data-kind')).toBe('gpx')
    expect(chip.querySelector('[data-role="name"]')!.textContent).toBe('Ridge loop.gpx')
    expect(chip.querySelector('[data-role="size"]')!.textContent).toBe('1.5 KB')
    expect(chip.querySelector('[data-role="pdf-viewer"]')).toBeNull()

    const button = chip.querySelector('button')!
    expect(button.textContent).toBe('Download')
    expect(button.disabled).toBe(false)
    button.click()
    expect(download).toHaveBeenCalledWith(AID, 'Ridge loop.gpx')
  })

  it('PDF chip shows the same controls plus a viewer slot', () => {
    const download = vi.fn<AttachmentDownloader>()
    const editor = makeEditor(doc(file(attachmentSrc(AID), { name: 'guide.pdf', size: 3 * 1024 * 1024, kind: 'pdf' })), {
      downloadAttachment: download,
    })

    const chip = editor.view.dom.querySelector<HTMLElement>('.attachment-file')!
    expect(chip.querySelector('[data-role="name"]')!.textContent).toBe('guide.pdf')
    expect(chip.querySelector('[data-role="size"]')!.textContent).toBe('3.0 MB')
    expect(chip.querySelector('[data-role="pdf-viewer"]')).not.toBeNull()
    chip.querySelector('button')!.click()
    expect(download).toHaveBeenCalledWith(AID, 'guide.pdf')
  })

  it('the Download button works in a read-only editor (the shared view)', () => {
    const download = vi.fn<AttachmentDownloader>()
    const editor = makeEditor(doc(file(attachmentSrc(AID))), { downloadAttachment: download, editable: false })
    editor.view.dom.querySelector('button')!.click()
    expect(download).toHaveBeenCalledWith(AID, 'route.gpx')
  })

  it('renders name and size as text, never as HTML', () => {
    const editor = makeEditor(doc(file(attachmentSrc(AID), { name: '<img src=x onerror=alert(1)><b>x</b>' })))
    const chip = editor.view.dom.querySelector<HTMLElement>('.attachment-file')!
    expect(chip.querySelector('img')).toBeNull()
    expect(chip.querySelector('b')).toBeNull()
    expect(chip.querySelector('[data-role="name"]')!.textContent).toBe('<img src=x onerror=alert(1)><b>x</b>')
  })

  it('falls back to a per-kind name and disables Download without a handler or a valid reference', () => {
    const editor = makeEditor(
      doc(file(attachmentSrc(AID), { name: null, kind: 'pdf', size: null }), file('https://example.com/x.gpx', { name: null })),
      { downloadAttachment: vi.fn() },
    )
    const [pdf, other] = editor.view.dom.querySelectorAll<HTMLElement>('.attachment-file')
    expect(pdf!.querySelector('[data-role="name"]')!.textContent).toBe('document.pdf')
    expect(pdf!.querySelector('[data-role="size"]')!.textContent).toBe('')
    expect(pdf!.querySelector('button')!.disabled).toBe(false)
    expect(other!.querySelector('[data-role="name"]')!.textContent).toBe('track.gpx')
    expect(other!.querySelector('button')!.disabled).toBe(true)
    expect(other!.hasAttribute('data-attachment-id')).toBe(false)

    const noHandler = makeEditor(doc(file(attachmentSrc(AID))))
    expect(noHandler.view.dom.querySelector('button')!.disabled).toBe(true)
  })

  it('updates the chip when the attrs change', () => {
    const download = vi.fn<AttachmentDownloader>()
    const editor = makeEditor(doc(file(attachmentSrc(AID))), { downloadAttachment: download })
    const pos = firstNodePos(editor, 'attachmentFile')
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, { src: attachmentSrc(OTHER_AID), name: 'new.pdf', size: 10, kind: 'pdf' }),
    )

    const chip = editor.view.dom.querySelector<HTMLElement>('.attachment-file')!
    expect(chip.getAttribute('data-attachment-id')).toBe(OTHER_AID)
    expect(chip.querySelector('[data-role="name"]')!.textContent).toBe('new.pdf')
    expect(chip.querySelector('[data-role="pdf-viewer"]')).not.toBeNull()
    chip.querySelector('button')!.click()
    expect(download).toHaveBeenCalledWith(OTHER_AID, 'new.pdf')
  })
})
