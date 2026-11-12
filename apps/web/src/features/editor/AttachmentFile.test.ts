import type { Editor, JSONContent } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyNodeAt, firstNodePos, pasteAtEnd } from '@/test/clipboard'
import { destroyEditors, doc, fileNode, fileNodes, makeEditor, ownerResolver } from '@/test/editor'
import { fileDisplayName, formatFileSize, type AttachmentDownloader } from './AttachmentFile'
import { attachmentSrc } from './attachmentRef'
import { mountPdfViewer } from './pdfViewerMount'

// the React PDF viewer has its own tests (PdfViewer.test.tsx); here only its mounting is checked
vi.mock('./pdfViewerMount', () => ({
  mountPdfViewer: vi.fn(() => ({ destroy: vi.fn() })),
}))
const mountMock = vi.mocked(mountPdfViewer)

const AID = '0b4c2f7e-1d2a-4c3b-9e8f-0123456789ab'
const OTHER_AID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

afterEach(async () => {
  await destroyEditors()
  mountMock.mockClear()
})

const paragraph = (text?: string): JSONContent => ({
  type: 'paragraph',
  ...(text ? { content: [{ type: 'text', text }] } : {}),
})

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
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID), { name: 'guide.pdf', size: 12345, kind: 'pdf' })))
    expect(fileNodes(editor.getJSON())).toEqual([
      { src: attachmentSrc(AID), name: 'guide.pdf', size: 12345, kind: 'pdf' },
    ])
    expect(JSON.stringify(editor.getJSON())).not.toContain('/api/attachments')
  })

  it('loads the server fixture shape (docWithFiles) as file nodes', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'files' }] },
        { type: 'attachmentFile', attrs: { src: `attachment://${AID}`, name: 'route.pdf', size: 1024, kind: 'pdf' } },
        { type: 'attachmentFile', attrs: { src: `attachment://${OTHER_AID}`, name: 'ridge.gpx', size: 1024, kind: 'gpx' } },
      ],
    })
    expect(fileNodes(editor.getJSON())).toEqual([
      { src: attachmentSrc(AID), name: 'route.pdf', size: 1024, kind: 'pdf' },
      { src: attachmentSrc(OTHER_AID), name: 'ridge.gpx', size: 1024, kind: 'gpx' },
    ])
  })
})

describe('AttachmentFile HTML (clipboard)', () => {
  it('renderHTML keeps attachment://<aid> and data-attachment-id, never a resolved URL', () => {
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID))))
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
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID), { name: '<img src=x onerror=alert(1)>.gpx' })))
    const html = editor.getHTML()
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.gpx')
  })

  it('copying a file puts the reference, not a resolved URL, on the clipboard, and its name as plain text', () => {
    const editor = makeEditor(doc(paragraph('before'), fileNode(attachmentSrc(AID)), paragraph('after')))
    const data = copyFirstFile(editor)
    const html = data.get('text/html')!
    expect(html).toContain(`data-attachment-id="${AID}"`)
    expect(html).toContain(`data-src="${attachmentSrc(AID)}"`)
    expect(html).not.toContain('/api/attachments')
    expect(data.get('text/plain')).toBe('route.gpx')
  })

  it('the plain-text copy of a nameless file is its per-kind fallback name', () => {
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID), { name: null, kind: 'pdf' })))
    expect(copyFirstFile(editor).get('text/plain')).toBe('document.pdf')
  })

  it('a pasted file block with only data-src="attachment://…" (no data-attachment-id) is kept', () => {
    const editor = makeEditor(doc(paragraph('x')))
    pasteAtEnd(
      editor,
      new Map([
        ['text/html', `<div data-type="attachment-file" data-src="${attachmentSrc(AID)}" data-name="a.gpx" data-kind="gpx">a.gpx</div>`],
      ]),
    )
    expect(fileNodes(editor.getJSON())).toEqual([{ src: attachmentSrc(AID), name: 'a.gpx', size: null, kind: 'gpx' }])
  })

  it('copy + paste within the same editor keeps the node and its attrs', () => {
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID), { name: 'g.pdf', size: 7, kind: 'pdf' }), paragraph('end')))
    pasteAtEnd(editor, copyFirstFile(editor))

    const expected = { src: attachmentSrc(AID), name: 'g.pdf', size: 7, kind: 'pdf' }
    expect(fileNodes(editor.getJSON())).toEqual([expected, expected])
    expect(editor.view.dom.querySelectorAll('.attachment-file')).toHaveLength(2)
  })

  it('copy from one editor + paste into a second editor keeps the node', () => {
    const source = makeEditor(doc(fileNode(attachmentSrc(AID))))
    const target = makeEditor(doc(paragraph('target')))
    pasteAtEnd(target, copyFirstFile(source))

    expect(fileNodes(target.getJSON())).toEqual([{ src: attachmentSrc(AID), name: 'route.gpx', size: 2048, kind: 'gpx' }])
  })

  it('cut + paste moves the reference', () => {
    const editor = makeEditor(doc(paragraph('a'), fileNode(attachmentSrc(AID)), paragraph('b')))
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
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID), { name: 'Ridge loop.gpx', size: 1536 })), {
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
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID), { name: 'guide.pdf', size: 3 * 1024 * 1024, kind: 'pdf' })), {
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
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID))), { downloadAttachment: download, editable: false })
    editor.view.dom.querySelector('button')!.click()
    expect(download).toHaveBeenCalledWith(AID, 'route.gpx')
  })

  it('renders name and size as text, never as HTML', () => {
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID), { name: '<img src=x onerror=alert(1)><b>x</b>' })))
    const chip = editor.view.dom.querySelector<HTMLElement>('.attachment-file')!
    expect(chip.querySelector('img')).toBeNull()
    expect(chip.querySelector('b')).toBeNull()
    expect(chip.querySelector('[data-role="name"]')!.textContent).toBe('<img src=x onerror=alert(1)><b>x</b>')
  })

  it('falls back to a per-kind name and disables Download without a valid reference', () => {
    const editor = makeEditor(
      doc(fileNode(attachmentSrc(AID), { name: null, kind: 'pdf', size: null }), fileNode('https://example.com/x.gpx', { name: null })),
      { downloadAttachment: vi.fn() },
    )
    const [pdf, other] = editor.view.dom.querySelectorAll<HTMLElement>('.attachment-file')
    expect(pdf!.querySelector('[data-role="name"]')!.textContent).toBe('document.pdf')
    expect(pdf!.querySelector('[data-role="size"]')!.textContent).toBe('')
    expect(pdf!.querySelector('button')!.disabled).toBe(false)
    expect(other!.querySelector('[data-role="name"]')!.textContent).toBe('track.gpx')
    expect(other!.querySelector('button')!.disabled).toBe(true)
    expect(other!.hasAttribute('data-attachment-id')).toBe(false)
  })

  it('updates the name and size in place, keeping the node view', () => {
    const download = vi.fn<AttachmentDownloader>()
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID), { kind: 'pdf' })), { downloadAttachment: download })
    const before = editor.view.dom.querySelector<HTMLElement>('.attachment-file')!
    const pos = firstNodePos(editor, 'attachmentFile')
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, { src: attachmentSrc(AID), name: 'renamed.pdf', size: 10, kind: 'pdf' }),
    )

    const chip = editor.view.dom.querySelector<HTMLElement>('.attachment-file')!
    expect(chip).toBe(before)
    expect(chip.querySelector('[data-role="name"]')!.textContent).toBe('renamed.pdf')
    expect(chip.querySelector('[data-role="size"]')!.textContent).toBe('10 B')
    expect(chip.querySelector('button')!.getAttribute('aria-label')).toBe('Download renamed.pdf')
    expect(mountMock).toHaveBeenCalledTimes(1)
    chip.querySelector('button')!.click()
    expect(download).toHaveBeenCalledWith(AID, 'renamed.pdf')
  })

  it('rebuilds the chip when the reference or kind changes', () => {
    const download = vi.fn<AttachmentDownloader>()
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID))), { downloadAttachment: download })
    const pos = firstNodePos(editor, 'attachmentFile')
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, { src: attachmentSrc(OTHER_AID), name: 'new.pdf', size: 10, kind: 'pdf' }),
    )

    const chip = editor.view.dom.querySelector<HTMLElement>('.attachment-file')!
    expect(chip.getAttribute('data-attachment-id')).toBe(OTHER_AID)
    expect(chip.getAttribute('data-kind')).toBe('pdf')
    expect(chip.querySelector('[data-role="name"]')!.textContent).toBe('new.pdf')
    expect(chip.querySelector('[data-role="pdf-viewer"]')).not.toBeNull()
    chip.querySelector('button')!.click()
    expect(download).toHaveBeenCalledWith(OTHER_AID, 'new.pdf')
  })

  it('keeps clicks on the Download button and inside the viewer away from the editor, but not clicks on the chip text', () => {
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID), { kind: 'pdf' })))
    // ProseMirror asks the node view's stopEvent; it is reachable only through the view's internals
    type Desc = { node: { type: { name: string } }; spec: { stopEvent: (event: Event) => boolean } }
    const descs = (editor.view as unknown as { docView: { children: Desc[] } }).docView.children
    const { stopEvent } = descs.find((desc) => desc.node.type.name === 'attachmentFile')!.spec
    const chip = editor.view.dom.querySelector<HTMLElement>('.attachment-file')!
    const slot = chip.querySelector<HTMLElement>('[data-role="pdf-viewer"]')!
    const inViewer = document.createElement('button')
    slot.append(inViewer)
    const click = (target: Element) => {
      const event = new MouseEvent('mousedown', { bubbles: true })
      Object.defineProperty(event, 'target', { value: target })
      return stopEvent(event)
    }

    expect(click(chip.querySelector('button')!)).toBe(true)
    expect(click(inViewer)).toBe(true)
    expect(click(chip.querySelector('[data-role="name"]')!)).toBe(false)
  })
})

describe('AttachmentFile PDF viewer mounting', () => {
  const lastMount = () => mountMock.mock.results.at(-1)!.value as { destroy: ReturnType<typeof vi.fn> }

  it('mounts the viewer into the PDF slot with the aid and the resolver', () => {
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID), { name: 'guide.pdf', kind: 'pdf' })))
    const slot = editor.view.dom.querySelector<HTMLElement>('[data-role="pdf-viewer"]')!
    expect(mountMock).toHaveBeenCalledTimes(1)
    expect(mountMock).toHaveBeenCalledWith(slot, AID, ownerResolver, null)
  })

  it('never mounts a viewer (or a slot) for a GPX or for a PDF without a valid reference', () => {
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID)), fileNode('https://example.com/x.pdf', { kind: 'pdf' })))
    expect(mountMock).not.toHaveBeenCalled()
    expect(editor.view.dom.querySelector('[data-role="pdf-viewer"]')).toBeNull()
  })

  it('replaces the viewer when the reference changes and removes it when the node stops being a PDF', () => {
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID), { kind: 'pdf' })))
    const first = lastMount()
    const pos = firstNodePos(editor, 'attachmentFile')

    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { src: attachmentSrc(OTHER_AID), kind: 'pdf' }))
    expect(first.destroy).toHaveBeenCalledTimes(1)
    expect(mountMock).toHaveBeenCalledTimes(2)
    expect(mountMock).toHaveBeenLastCalledWith(expect.any(HTMLElement), OTHER_AID, ownerResolver, null)
    const second = lastMount()

    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { src: attachmentSrc(OTHER_AID), kind: 'gpx' }))
    expect(second.destroy).toHaveBeenCalledTimes(1)
    expect(mountMock).toHaveBeenCalledTimes(2)
    expect(editor.view.dom.querySelector('[data-role="pdf-viewer"]')).toBeNull()
  })

  it('unmounts the viewer when the node is deleted or the editor is destroyed', () => {
    const editor = makeEditor(doc(fileNode(attachmentSrc(AID), { kind: 'pdf' }), paragraph('after')))
    const first = lastMount()
    const pos = firstNodePos(editor, 'attachmentFile')
    editor.view.dispatch(editor.state.tr.delete(pos, pos + 1))
    expect(first.destroy).toHaveBeenCalledTimes(1)

    const other = makeEditor(doc(fileNode(attachmentSrc(AID), { kind: 'pdf' })))
    const second = lastMount()
    other.destroy()
    expect(second.destroy).toHaveBeenCalledTimes(1)
  })
})
