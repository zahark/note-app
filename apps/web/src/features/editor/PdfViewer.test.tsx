import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, isUnauthorized } from '@/lib/api'
import { destroyEditors, doc, fileNode, makeEditor, ownerResolver } from '@/test/editor'
import type { AttachmentDownloader } from './AttachmentFile'
import { attachmentSrc } from './attachmentRef'
import { loadPdf, type PdfDocument, type PdfLoad } from './pdf'
import { PdfViewer } from './PdfViewer'

// PDF.js is mocked at the `pdf.ts` boundary
vi.mock('./pdf', () => ({ loadPdf: vi.fn() }))
const loadPdfMock = vi.mocked(loadPdf)

const AID = '0b4c2f7e-1d2a-4c3b-9e8f-0123456789ab'
const OTHER_AID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const PDF_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37] // %PDF-1.7

interface FakePdf {
  doc: PdfDocument
  load: PdfLoad
  renderPage: ReturnType<typeof vi.fn<PdfDocument['renderPage']>>
  destroy: ReturnType<typeof vi.fn<() => void>>
  /** Settles the pending load. */
  resolve: () => void
  reject: (error: Error) => void
}

/** A PDF of `numPages` pages whose load the test settles; every page render succeeds. */
function fakePdf(numPages: number): FakePdf {
  const renderPage = vi.fn<PdfDocument['renderPage']>(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
  const doc: PdfDocument = { numPages, renderPage }
  const destroy = vi.fn<() => void>()
  let resolve!: (doc: PdfDocument) => void
  let reject!: (error: Error) => void
  const promise = new Promise<PdfDocument>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { doc, load: { promise, destroy }, renderPage, destroy, resolve: () => resolve(doc), reject }
}

/** Stubs `fetch` with the PDF bytes for `/api/attachments/<aid>` (and blob: URLs); 404 otherwise. */
function stubPdfFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/attachments/') || url.startsWith('blob:')) {
      return new Response(new Uint8Array(PDF_BYTES), { headers: { 'content-type': 'application/pdf' } })
    }
    return new Response(null, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

let fetchMock: ReturnType<typeof stubPdfFetch>
beforeEach(() => {
  fetchMock = stubPdfFetch()
  loadPdfMock.mockReset()
})

describe('PdfViewer', () => {
  it('shows a loading state, then renders page 1 with "Page 1 of n"', async () => {
    const pdf = fakePdf(3)
    loadPdfMock.mockReturnValue(pdf.load)
    render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading preview')
    await waitFor(() => expect(loadPdfMock).toHaveBeenCalledTimes(1))
    await act(async () => pdf.resolve())

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    expect(pdf.renderPage).toHaveBeenCalledTimes(1)
    const [pageNumber, canvas] = pdf.renderPage.mock.calls[0]!
    expect(pageNumber).toBe(1)
    expect(canvas).toBeInstanceOf(HTMLCanvasElement)
    expect(canvas.hidden).toBe(false)
  })

  it('fetches the bytes from the resolved URL and hands PDF.js an ArrayBuffer, never a URL', async () => {
    const pdf = fakePdf(1)
    loadPdfMock.mockReturnValue(pdf.load)
    render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)

    await waitFor(() => expect(loadPdfMock).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(`/api/attachments/${AID}`, expect.objectContaining({ credentials: 'same-origin' }))
    const data = loadPdfMock.mock.calls[0]![0]
    expect(typeof data).not.toBe('string')
    expect(Array.from(new Uint8Array(data))).toEqual(PDF_BYTES)
  })

  it('works with an async resolver (the shared view hands out blob URLs)', async () => {
    const pdf = fakePdf(1)
    loadPdfMock.mockReturnValue(pdf.load)
    const resolve = vi.fn(async () => 'blob:http://localhost/1234')
    render(<PdfViewer aid={AID} resolveAttachment={resolve} />)

    await waitFor(() => expect(loadPdfMock).toHaveBeenCalledTimes(1))
    expect(resolve).toHaveBeenCalledWith(AID)
    expect(fetchMock).toHaveBeenCalledWith('blob:http://localhost/1234', expect.anything())
  })

  it('pages with previous/next; the buttons are disabled at the ends', async () => {
    const user = userEvent.setup()
    const pdf = fakePdf(3)
    pdf.resolve()
    loadPdfMock.mockReturnValue(pdf.load)
    render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)

    const prev = await screen.findByRole('button', { name: 'Previous page' })
    const next = screen.getByRole('button', { name: 'Next page' })
    expect(prev).toBeDisabled()
    expect(next).toBeEnabled()

    await user.click(next)
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument()
    expect(pdf.renderPage).toHaveBeenLastCalledWith(2, expect.any(HTMLCanvasElement), expect.any(Number))
    expect(prev).toBeEnabled()

    await user.click(next)
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument()
    expect(next).toBeDisabled()

    await user.click(prev)
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument()
    expect(pdf.renderPage).toHaveBeenLastCalledWith(2, expect.any(HTMLCanvasElement), expect.any(Number))
  })

  it('cancels a page render that is superseded', async () => {
    const user = userEvent.setup()
    const pdf = fakePdf(2)
    const cancel = vi.fn()
    pdf.renderPage.mockImplementationOnce(() => ({ promise: new Promise<void>(() => {}), cancel }))
    pdf.resolve()
    loadPdfMock.mockReturnValue(pdf.load)
    render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)

    await user.click(await screen.findByRole('button', { name: 'Next page' }))
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('a single-page PDF has both buttons disabled', async () => {
    const pdf = fakePdf(1)
    pdf.resolve()
    loadPdfMock.mockReturnValue(pdf.load)
    render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)

    expect(await screen.findByText('Page 1 of 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
  })

  it('shows "Preview unavailable" when PDF.js cannot open the file', async () => {
    const pdf = fakePdf(1)
    pdf.reject(new Error('Invalid PDF structure'))
    loadPdfMock.mockReturnValue(pdf.load)
    render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Preview unavailable, download instead')
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull()
  })

  it('shows "Preview unavailable" when the bytes cannot be fetched (PDF.js is never called)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Preview unavailable')
    expect(loadPdfMock).not.toHaveBeenCalled()
  })

  it('an expired session is reported to onError as a session 401 (ApiError), with the error state shown', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const onError = vi.fn()
    render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} onError={onError} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Preview unavailable')
    expect(onError).toHaveBeenCalledTimes(1)
    const err: unknown = onError.mock.calls[0]![0]
    expect(err).toBeInstanceOf(ApiError)
    expect(isUnauthorized(err)).toBe(true)
    expect(loadPdfMock).not.toHaveBeenCalled()
  })

  it('a PDF.js failure is reported to onError too; a successful load never calls it', async () => {
    const broken = fakePdf(1)
    const failure = new Error('Invalid PDF structure')
    broken.reject(failure)
    loadPdfMock.mockReturnValue(broken.load)
    const onError = vi.fn()
    const { unmount } = render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} onError={onError} />)
    await screen.findByRole('alert')
    expect(onError).toHaveBeenCalledWith(failure)
    unmount()

    const ok = fakePdf(1)
    ok.resolve()
    loadPdfMock.mockReturnValue(ok.load)
    const onOkError = vi.fn()
    render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} onError={onOkError} />)
    await screen.findByText('Page 1 of 1')
    expect(onOkError).not.toHaveBeenCalled()
  })

  it('fetches the bytes without asking for JSON', async () => {
    loadPdfMock.mockReturnValue(fakePdf(1).load)
    render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)
    await waitFor(() => expect(loadPdfMock).toHaveBeenCalledTimes(1))
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit
    expect((init.headers as Record<string, string>).accept).toBeUndefined()
  })

  it('shows "Preview unavailable" when the resolver fails or there is none', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('unavailable')))
    const { unmount } = render(<PdfViewer aid={AID} resolveAttachment={failing} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Preview unavailable')
    unmount()

    render(<PdfViewer aid={AID} resolveAttachment={null} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Preview unavailable')
    expect(loadPdfMock).not.toHaveBeenCalled()
  })

  it('a failed page render shows the error state', async () => {
    const pdf = fakePdf(1)
    pdf.renderPage.mockImplementation(() => ({ promise: Promise.reject(new Error('bad page')), cancel: vi.fn() }))
    pdf.resolve()
    loadPdfMock.mockReturnValue(pdf.load)
    render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Preview unavailable')
  })

  it('fits the page to the container width and re-renders when that width changes', async () => {
    let report!: (width: number) => void
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          report = (width) =>
            callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver)
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    const pdf = fakePdf(2)
    pdf.resolve()
    loadPdfMock.mockReturnValue(pdf.load)
    const { container } = render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)
    await screen.findByText('Page 1 of 2')

    act(() => report(320))
    expect(pdf.renderPage).toHaveBeenLastCalledWith(1, expect.any(HTMLCanvasElement), 320)
    act(() => report(480.6))
    expect(pdf.renderPage).toHaveBeenLastCalledWith(1, expect.any(HTMLCanvasElement), 480)
    const calls = pdf.renderPage.mock.calls.length
    act(() => report(480.2))
    expect(pdf.renderPage).toHaveBeenCalledTimes(calls)
    // the scroll box always reserves the scrollbar gutter, so a scrollbar never changes the fitted width
    expect(container.querySelector('.overflow-auto')).toHaveClass('[scrollbar-gutter:stable]')
  })

  it('fetches and opens the PDF only once the viewer comes into view', async () => {
    let reveal!: () => void
    const observe = vi.fn()
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          reveal = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
        }
        observe = observe
        unobserve() {}
        disconnect() {}
      },
    )
    const pdf = fakePdf(1)
    pdf.resolve()
    loadPdfMock.mockReturnValue(pdf.load)
    render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)

    await act(async () => {})
    expect(observe).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('Loading preview')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(loadPdfMock).not.toHaveBeenCalled()

    act(() => reveal())
    expect(await screen.findByText('Page 1 of 1')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('aborts a running fetch of the bytes on unmount', async () => {
    let signal: AbortSignal | undefined
    fetchMock.mockImplementation((_input, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    const { unmount } = render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(signal?.aborted).toBe(false)
    unmount()
    expect(signal?.aborted).toBe(true)
    expect(loadPdfMock).not.toHaveBeenCalled()
  })

  it('destroys the PDF on unmount, also while it is still loading', async () => {
    const loaded = fakePdf(1)
    loaded.resolve()
    loadPdfMock.mockReturnValue(loaded.load)
    const first = render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)
    await screen.findByText('Page 1 of 1')
    first.unmount()
    expect(loaded.destroy).toHaveBeenCalledTimes(1)

    const loading = fakePdf(1)
    loadPdfMock.mockReturnValue(loading.load)
    const second = render(<PdfViewer aid={AID} resolveAttachment={ownerResolver} />)
    await waitFor(() => expect(loadPdfMock).toHaveBeenCalledTimes(2))
    second.unmount()
    expect(loading.destroy).toHaveBeenCalledTimes(1)
  })
})

describe('PdfViewer in the AttachmentFile node view', () => {
  afterEach(destroyEditors)

  const pdfNode = (aid: string, name: string) => fileNode(attachmentSrc(aid), { kind: 'pdf', name })

  it('a PDF node shows the viewer with page 1', async () => {
    const pdf = fakePdf(2)
    pdf.resolve()
    loadPdfMock.mockReturnValue(pdf.load)
    const editor = makeEditor(doc(pdfNode(AID, 'guide.pdf')))

    expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument()
    const slot = editor.view.dom.querySelector('[data-role="pdf-viewer"]')!
    expect(slot.querySelector('canvas')).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(`/api/attachments/${AID}`, expect.anything())
  })

  it('the next button works inside the editor', async () => {
    const user = userEvent.setup()
    const pdf = fakePdf(2)
    pdf.resolve()
    loadPdfMock.mockReturnValue(pdf.load)
    makeEditor(doc(pdfNode(AID, 'guide.pdf')))

    await user.click(await screen.findByRole('button', { name: 'Next page' }))
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument()
  })

  it('is not created for a GPX node (nothing is fetched or loaded)', async () => {
    makeEditor(doc(fileNode(attachmentSrc(AID))))
    await act(async () => {})
    expect(document.querySelector('[data-role="pdf-viewer"]')).toBeNull()
    expect(document.querySelector('.pdf-viewer')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(loadPdfMock).not.toHaveBeenCalled()
  })

  it('in the error state the chip Download button still works', async () => {
    const user = userEvent.setup()
    const pdf = fakePdf(1)
    pdf.reject(new Error('corrupt'))
    loadPdfMock.mockReturnValue(pdf.load)
    const download = vi.fn<AttachmentDownloader>()
    makeEditor(doc(pdfNode(AID, 'broken.pdf')), { downloadAttachment: download })

    expect(await screen.findByRole('alert')).toHaveTextContent('Preview unavailable, download instead')
    await user.click(screen.getByRole('button', { name: 'Download broken.pdf' }))
    expect(download).toHaveBeenCalledWith(AID, 'broken.pdf')
  })

  it('a new reference loads the new PDF and destroys the old one', async () => {
    const first = fakePdf(1)
    first.resolve()
    const second = fakePdf(4)
    second.resolve()
    loadPdfMock.mockReturnValueOnce(first.load).mockReturnValueOnce(second.load)
    const editor = makeEditor(doc(pdfNode(AID, 'a.pdf')))
    await screen.findByText('Page 1 of 1')

    act(() => {
      editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { src: attachmentSrc(OTHER_AID), kind: 'pdf' }))
    })
    expect(await screen.findByText('Page 1 of 4')).toBeInTheDocument()
    expect(first.destroy).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/attachments/${OTHER_AID}`, expect.anything())
  })

  it('destroying the editor unmounts the viewer and destroys the PDF', async () => {
    const pdf = fakePdf(1)
    pdf.resolve()
    loadPdfMock.mockReturnValue(pdf.load)
    const editor = makeEditor(doc(pdfNode(AID, 'guide.pdf')))
    await screen.findByText('Page 1 of 1')

    await act(async () => {
      editor.destroy()
    })
    expect(pdf.destroy).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Page 1 of 1')).toBeNull()
  })
})
