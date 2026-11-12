import type { JSONContent } from '@tiptap/core'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachmentSrc } from '@/features/editor/attachmentRef'
import { loadPdf, type PdfDocument } from '@/features/editor/pdf'
import { createQueryClient } from '@/lib/queryClient'
import { doc, fileNode } from '@/test/editor'
import { mockFetch, renderApp, type MockResponse, type RecordedRequest } from '@/test/utils'
import { GENERIC_UNLOCK_ERROR } from './api'

// PDF.js is mocked at the `pdf.ts` boundary
vi.mock('@/features/editor/pdf', () => ({ loadPdf: vi.fn() }))
const loadPdfMock = vi.mocked(loadPdf)

const NOTE_ID = '33333333-3333-4333-8333-333333333333'
const AID = '0b4c2f7e-1d2a-4c3b-9e8f-0123456789ab'
const TOKEN = '1999999999.c2VjcmV0LXRva2VuLXZhbHVl'
const EXP = '1999999999'
const SIG = 'abc_DEF-123'

const unlockPath = `POST /api/shared/${NOTE_ID}/unlock`
const notePath = `GET /api/shared/${NOTE_ID}`
const signedNotePath = `GET /api/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`
const attachmentPath = `GET /api/shared/${NOTE_ID}/attachments/${AID}`
const signedAttachmentPath = `${attachmentPath}?exp=${EXP}&sig=${SIG}`

const unavailable: MockResponse = {
  status: 404,
  body: { error: { code: 'UNAVAILABLE', message: 'This shared note is unavailable' } },
}

const paragraph = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const image = (aid: string): JSONContent => ({ type: 'image', attrs: { src: `attachment://${aid}` } })

const sharedNote = (content: JSONContent = doc(paragraph('Shared body'))): MockResponse => ({
  body: { note: { title: 'Trip plan', content, attachment_ids: [AID] } },
})

const headersOf = (req: RecordedRequest) => (req.init.headers ?? {}) as Record<string, string>

let blobCount = 0
beforeEach(() => {
  blobCount = 0
  loadPdfMock.mockReset()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => `blob:http://localhost/${++blobCount}`),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
})
afterEach(() => {
  delete (URL as { createObjectURL?: unknown }).createObjectURL
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
})

async function unlockWith(pin: string) {
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('PIN'), pin)
  await user.click(screen.getByRole('button', { name: 'Unlock' }))
}

describe('lock screen', () => {
  it('asks for the PIN without contacting the server, and keeps Unlock disabled until one is typed', async () => {
    const { fetchMock } = mockFetch({})
    renderApp(`/shared/${NOTE_ID}`)
    expect(await screen.findByRole('heading', { name: 'This note is protected' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeDisabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('submits the PIN, then shows the note read-only with no sidebar or editor chrome', async () => {
    const { requests } = mockFetch({
      [unlockPath]: { body: { token: TOKEN, expires_at: 1999999999 } },
      [notePath]: sharedNote(),
    })
    renderApp(`/shared/${NOTE_ID}`)
    await unlockWith('abcd2345')

    expect(await screen.findByRole('heading', { name: 'Trip plan' })).toBeInTheDocument()
    const content = screen.getByLabelText('Shared note content')
    expect(content).toHaveTextContent('Shared body')
    expect(content).toHaveAttribute('contenteditable', 'false')
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /new note/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Note title')).not.toBeInTheDocument()

    const unlock = requests.find((r) => r.method === 'POST')!
    expect(unlock.body).toEqual({ pin: 'abcd2345' })
    expect(unlock.init.credentials).toBe('omit')
    const load = requests.find((r) => `${r.method} ${r.path}` === notePath)!
    expect(headersOf(load).authorization).toBe(`Bearer ${TOKEN}`)
    expect(load.init.credentials).toBe('omit')
  })

  it('shows one generic error for a wrong PIN and stays locked', async () => {
    mockFetch({ [unlockPath]: unavailable })
    renderApp(`/shared/${NOTE_ID}`)
    await unlockWith('WRONGPIN')

    expect(await screen.findByRole('alert')).toHaveTextContent(GENERIC_UNLOCK_ERROR)
    expect(screen.getByLabelText('PIN')).toHaveValue('')
    expect(screen.getByRole('heading', { name: 'This note is protected' })).toBeInTheDocument()
  })

  it('shows a lockout message with the wait time on 429', async () => {
    mockFetch({
      [unlockPath]: {
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } },
        headers: { 'retry-after': '540' },
      },
    })
    renderApp(`/shared/${NOTE_ID}`)
    await unlockWith('ABCD2345')
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again in 9 minutes.')
  })

  it('shows a lockout message without a wait time when the server gives none', async () => {
    mockFetch({
      [unlockPath]: { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'Too many attempts' } } },
    })
    renderApp(`/shared/${NOTE_ID}`)
    await unlockWith('ABCD2345')
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again later.')
  })
})

describe('unavailable view', () => {
  /** Renders a scenario and returns the markup of the page it ends on. */
  async function unavailableMarkup(path: string, routes: Record<string, MockResponse>, pin?: string) {
    const { requests } = mockFetch(routes)
    const { unmount } = renderApp(path)
    if (pin) await unlockWith(pin)
    const markup = (await screen.findByTestId('shared-unavailable')).outerHTML
    unmount()
    // each scenario made exactly the requests it describes (an unmatched URL would also end on the
    // unavailable page, through the mock's default 404, and prove nothing)
    expect(requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual(Object.keys(routes).sort())
    return markup
  }

  it('is identical for an expired, tampered or revoked link, a missing note and a token that stopped working', async () => {
    const signedPath = `/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`
    const pages = [
      // expired / tampered / revoked link: the server answers the same 404 for all
      await unavailableMarkup(signedPath, { [signedNotePath]: unavailable }),
      // a malformed link (only one of the params)
      await unavailableMarkup(`/shared/${NOTE_ID}?sig=${SIG}`, {
        [`GET /api/shared/${NOTE_ID}?exp=&sig=${SIG}`]: unavailable,
      }),
      // a strictly validated request rejected as malformed
      await unavailableMarkup(signedPath, {
        [signedNotePath]: { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'Invalid request' } } },
      }),
      // unlocked, but the share was stopped before the note loaded
      await unavailableMarkup(
        `/shared/${NOTE_ID}`,
        { [unlockPath]: { body: { token: TOKEN, expires_at: 1999999999 } }, [notePath]: unavailable },
        'ABCD2345',
      ),
    ]
    expect(new Set(pages).size).toBe(1)
    expect(pages[0]).toContain('This shared note is unavailable')
  })
})

describe('server or network trouble', () => {
  /** A query client that does not retry, so a failed load shows its page at once. */
  function noRetryClient() {
    const client = createQueryClient()
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } })
    return client
  }

  const serverError: MockResponse = { status: 500, body: { error: { code: 'INTERNAL', message: 'Server error' } } }
  const networkDown = () => {
    throw new TypeError('Failed to fetch')
  }

  it.each([
    ['a server error', () => serverError],
    ['a network error', networkDown],
  ])('loading the note after %s offers a retry instead of the unavailable page', async (_name, failure) => {
    let fail = true
    mockFetch({ [signedNotePath]: () => (fail ? failure() : sharedNote()) })
    renderApp(`/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`, noRetryClient())

    expect(await screen.findByText(/Could not load this note/)).toBeInTheDocument()
    expect(screen.queryByTestId('shared-unavailable')).not.toBeInTheDocument()
    fail = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('heading', { name: 'Trip plan' })).toBeInTheDocument()
  })

  it.each([
    ['a server error', () => serverError],
    ['a network error', networkDown],
  ])('unlocking after %s asks to try again in a moment, and a retry unlocks', async (_name, failure) => {
    let fail = true
    mockFetch({
      [unlockPath]: () => (fail ? failure() : { body: { token: TOKEN, expires_at: 1999999999 } }),
      [notePath]: sharedNote(),
    })
    renderApp(`/shared/${NOTE_ID}`)
    await unlockWith('ABCD2345')

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not unlock right now. Try again in a moment.')
    fail = false
    await unlockWith('ABCD2345')
    expect(await screen.findByRole('heading', { name: 'Trip plan' })).toBeInTheDocument()
  })
})

describe('shared images', () => {
  it('PIN mode: fetches images with the token in the Authorization header and shows blob URLs; the token is never in a URL', async () => {
    const { requests } = mockFetch({
      [unlockPath]: { body: { token: TOKEN, expires_at: 1999999999 } },
      [notePath]: sharedNote(doc(paragraph('With a photo'), image(AID))),
      [attachmentPath]: { body: 'image-bytes', headers: { 'content-type': 'image/png' } },
    })
    const { container, unmount } = renderApp(`/shared/${NOTE_ID}`)
    await unlockWith('ABCD2345')

    await screen.findByRole('heading', { name: 'Trip plan' })
    const img = container.querySelector(`img[data-attachment-id="${AID}"]`) as HTMLImageElement
    await waitFor(() => expect(img.getAttribute('src')).toBe('blob:http://localhost/1'))

    const fetchImage = requests.find((r) => `${r.method} ${r.path}` === attachmentPath)!
    expect(headersOf(fetchImage).authorization).toBe(`Bearer ${TOKEN}`)
    expect(fetchImage.init.credentials).toBe('omit')

    // the token is only ever in a header: never in a request URL, the page URL, an image src or storage
    for (const req of requests) expect(req.path).not.toContain(TOKEN)
    expect(screen.getByTestId('search').textContent).not.toContain(TOKEN)
    expect(container.innerHTML).not.toContain(TOKEN)
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN)
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN)

    // the blob URL is released when the page goes away
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/1')
  })

  it('signed mode: loads the note and images with the page exp/sig and no Authorization header', async () => {
    const { requests } = mockFetch({
      [signedNotePath]: sharedNote(doc(image(AID))),
      [signedAttachmentPath]: { body: 'image-bytes', headers: { 'content-type': 'image/png' } },
    })
    const { container } = renderApp(`/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`)

    expect(await screen.findByRole('heading', { name: 'Trip plan' })).toBeInTheDocument()
    expect(screen.queryByLabelText('PIN')).not.toBeInTheDocument()
    const img = container.querySelector(`img[data-attachment-id="${AID}"]`) as HTMLImageElement
    await waitFor(() => expect(img.getAttribute('src')).toBe('blob:http://localhost/1'))

    for (const req of requests) {
      expect(headersOf(req).authorization).toBeUndefined()
      expect(req.init.credentials).toBe('omit')
    }
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([signedNotePath, signedAttachmentPath])
  })

  it('titles a note whose title is blank or whitespace "Untitled", as the sidebar does', async () => {
    mockFetch({ [signedNotePath]: { body: { note: { title: '   ', content: doc(paragraph('Body')), attachment_ids: [] } } } })
    renderApp(`/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`)
    expect(await screen.findByRole('heading', { name: 'Untitled' })).toBeInTheDocument()
  })

  it('leaves an image empty (no unresolved reference) when it cannot be loaded', async () => {
    mockFetch({ [signedNotePath]: sharedNote(doc(image(AID))), [signedAttachmentPath]: unavailable })
    const { container } = renderApp(`/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`)
    await screen.findByRole('heading', { name: 'Trip plan' })
    const img = container.querySelector(`img[data-attachment-id="${AID}"]`) as HTMLImageElement
    await waitFor(() => expect(img).toHaveAttribute('data-load-error', 'true'))
    expect(img).not.toHaveAttribute('src')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})

/** A loaded PDF of `numPages` pages whose page renders all succeed. */
function stubPdf(numPages: number) {
  const renderPage = vi.fn<PdfDocument['renderPage']>(() => ({ promise: Promise.resolve(), cancel: vi.fn() }))
  const destroy = vi.fn<() => void>()
  loadPdfMock.mockReturnValue({ promise: Promise.resolve({ numPages, renderPage }), destroy })
  return { renderPage, destroy }
}

/** Records the download anchors clicked (jsdom cannot navigate to them). */
function captureDownloads() {
  const clicked: { href: string; download: string; connected: boolean }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.getAttribute('href')!, download: this.download, connected: this.isConnected })
  })
  return clicked
}

const pdfBytes = { body: '%PDF-1.7', headers: { 'content-type': 'application/pdf' } }
/** A GPX response as the server sends it: typed, and named by `Content-Disposition`. */
const namedGpx = (name: string): MockResponse => ({
  body: '<gpx/>',
  headers: { 'content-type': 'application/gpx+xml', 'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${name}` },
})
const BLOB_1 = 'blob:http://localhost/1'

describe('shared files', () => {
  afterEach(() => vi.restoreAllMocks())

  it('PIN mode: a PDF shows the viewer, its bytes fetched with the token in a header and read from a blob URL', async () => {
    const pdf = stubPdf(2)
    const { requests } = mockFetch({
      [unlockPath]: { body: { token: TOKEN, expires_at: 1999999999 } },
      [notePath]: sharedNote(doc(paragraph('Route'), fileNode(attachmentSrc(AID), { kind: 'pdf', name: 'guide.pdf' }))),
      [attachmentPath]: pdfBytes,
      [`GET ${BLOB_1}`]: pdfBytes,
    })
    const { container, unmount } = renderApp(`/shared/${NOTE_ID}`)
    await unlockWith('ABCD2345')

    expect(await screen.findByText('Page 1 of 2')).toBeInTheDocument()
    expect(container.querySelector(`[data-attachment-id="${AID}"] [data-role="pdf-viewer"]`)).not.toBeNull()
    expect(pdf.renderPage).toHaveBeenCalledWith(1, expect.any(HTMLCanvasElement), expect.any(Number))

    const fetchPdf = requests.find((r) => `${r.method} ${r.path}` === attachmentPath)!
    expect(headersOf(fetchPdf).authorization).toBe(`Bearer ${TOKEN}`)
    expect(fetchPdf.init.credentials).toBe('omit')
    // the API is asked once; PDF.js gets the bytes already loaded (from the blob URL), never the API URL
    expect(new Set(requests.map((r) => `${r.method} ${r.path}`))).toEqual(
      new Set([unlockPath, notePath, attachmentPath, `GET ${BLOB_1}`]),
    )
    expect(requests.filter((r) => `${r.method} ${r.path}` === attachmentPath)).toHaveLength(1)

    for (const req of requests) expect(req.path).not.toContain(TOKEN)
    expect(container.innerHTML).not.toContain(TOKEN)

    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(BLOB_1)
    // the viewer's own root unmounts a microtask later, destroying every PDF it opened
    expect(loadPdfMock).toHaveBeenCalled()
    await waitFor(() => expect(pdf.destroy).toHaveBeenCalledTimes(loadPdfMock.mock.calls.length))
  })

  it('signed mode: a PDF is fetched with the page exp/sig and no Authorization header', async () => {
    stubPdf(1)
    const { requests } = mockFetch({
      [signedNotePath]: sharedNote(doc(fileNode(attachmentSrc(AID), { kind: 'pdf', name: 'guide.pdf' }))),
      [signedAttachmentPath]: pdfBytes,
      [`GET ${BLOB_1}`]: pdfBytes,
    })
    renderApp(`/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`)

    expect(await screen.findByText('Page 1 of 1')).toBeInTheDocument()
    expect(new Set(requests.map((r) => `${r.method} ${r.path}`))).toEqual(
      new Set([signedNotePath, signedAttachmentPath, `GET ${BLOB_1}`]),
    )
    expect(requests.filter((r) => `${r.method} ${r.path}` === signedAttachmentPath)).toHaveLength(1)
    for (const req of requests) expect(headersOf(req).authorization).toBeUndefined()
  })

  it('PIN mode: a GPX chip downloads through a credentialed fetch and a blob URL named after the stored file', async () => {
    const clicked = captureDownloads()
    const { requests } = mockFetch({
      [unlockPath]: { body: { token: TOKEN, expires_at: 1999999999 } },
      [notePath]: sharedNote(doc(fileNode(attachmentSrc(AID), { kind: 'gpx', name: 'ride.gpx' }))),
      [attachmentPath]: {
        body: '<gpx/>',
        headers: {
          'content-type': 'application/gpx+xml',
          'content-disposition': `attachment; filename="_____ ride.gpx"; filename*=UTF-8''%D0%A2%D1%80%D0%B0%D1%81%D1%81%D0%B0%20ride.gpx`,
        },
      },
    })
    const { container, unmount } = renderApp(`/shared/${NOTE_ID}`)
    await unlockWith('ABCD2345')

    const button = await screen.findByRole('button', { name: 'Download ride.gpx' })
    // a GPX gets no viewer, and nothing is fetched until Download is pressed
    expect(container.querySelector('[data-role="pdf-viewer"]')).toBeNull()
    expect(requests.some((r) => r.path.includes('/attachments/'))).toBe(false)

    await userEvent.setup().click(button)
    await waitFor(() => expect(clicked).toEqual([{ href: BLOB_1, download: 'Трасса ride.gpx', connected: true }]))

    const fetchGpx = requests.find((r) => `${r.method} ${r.path}` === attachmentPath)!
    expect(headersOf(fetchGpx).authorization).toBe(`Bearer ${TOKEN}`)
    expect(fetchGpx.init.credentials).toBe('omit')
    for (const req of requests) expect(req.path).not.toContain(TOKEN)
    for (const { href } of clicked) expect(href).not.toContain(TOKEN)
    expect(container.innerHTML).not.toContain(TOKEN)
    // the anchor is temporary
    expect(document.querySelector(`a[href="${BLOB_1}"]`)).toBeNull()

    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(BLOB_1)
  })

  it('signed mode: repeated downloads reuse the fetched blob and the stored name', async () => {
    const clicked = captureDownloads()
    const { requests } = mockFetch({
      [signedNotePath]: sharedNote(doc(fileNode(attachmentSrc(AID), { kind: 'gpx', name: 'ride.gpx' }))),
      [signedAttachmentPath]: namedGpx('ride.gpx'),
    })
    renderApp(`/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`)

    const user = userEvent.setup()
    const button = await screen.findByRole('button', { name: 'Download ride.gpx' })
    await user.click(button)
    await waitFor(() => expect(clicked).toHaveLength(1))
    await user.click(button)
    await waitFor(() => expect(clicked).toHaveLength(2))

    expect(clicked[0]).toEqual({ href: BLOB_1, download: 'ride.gpx', connected: true })
    expect(clicked[1]).toEqual(clicked[0])
    expect(requests.filter((r) => `${r.method} ${r.path}` === signedAttachmentPath)).toHaveLength(1)
    for (const req of requests) expect(headersOf(req).authorization).toBeUndefined()
  })

  it.each([
    ['no Content-Disposition', { body: '<gpx/>', headers: { 'content-type': 'application/gpx+xml' } }],
    ['an unparseable Content-Disposition', { body: '<gpx/>', headers: { 'content-type': 'application/gpx+xml', 'content-disposition': 'attachment' } }],
    [
      'a name not ending in the type extension',
      { body: '<gpx/>', headers: { 'content-type': 'application/gpx+xml', 'content-disposition': `attachment; filename="x.js"` } },
    ],
  ])('a download whose response has %s is refused with an error, never saved under the chip name', async (_name, response) => {
    const clicked = captureDownloads()
    mockFetch({
      [signedNotePath]: sharedNote(doc(fileNode(attachmentSrc(AID), { kind: 'gpx', name: 'ride.gpx' }))),
      [signedAttachmentPath]: response as MockResponse,
    })
    renderApp(`/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`)

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Download ride.gpx' }))
    expect(await screen.findByText('Could not download ride.gpx: it is not a PDF or GPX file')).toBeInTheDocument()
    expect(clicked).toEqual([])
  })

  it.each(['PIN', 'signed'] as const)(
    '%s mode: a file node pointing at an image attachment named x.js is never downloaded',
    async (mode) => {
      const clicked = captureDownloads()
      const imageResponse: MockResponse = {
        body: 'GIF89a-image-bytes',
        headers: { 'content-type': 'image/gif', 'content-disposition': `inline; filename="x.js.gif"; filename*=UTF-8''x.js.gif` },
      }
      const content = sharedNote(doc(fileNode(attachmentSrc(AID), { kind: 'gpx', name: 'x.js' })))
      mockFetch(
        mode === 'PIN'
          ? { [unlockPath]: { body: { token: TOKEN, expires_at: 1999999999 } }, [notePath]: content, [attachmentPath]: imageResponse }
          : { [signedNotePath]: content, [signedAttachmentPath]: imageResponse },
      )
      renderApp(mode === 'PIN' ? `/shared/${NOTE_ID}` : `/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`)
      if (mode === 'PIN') await unlockWith('ABCD2345')

      await userEvent.setup().click(await screen.findByRole('button', { name: 'Download x.js' }))
      expect(await screen.findByText('Could not download x.js: it is not a PDF or GPX file')).toBeInTheDocument()
      expect(clicked).toEqual([])
    },
  )

  it('blob URLs of files are typed application/octet-stream (they never render on the app origin); images keep their type', async () => {
    stubPdf(1)
    const IMAGE_AID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    mockFetch({
      [signedNotePath]: sharedNote(doc(fileNode(attachmentSrc(AID), { kind: 'pdf', name: 'guide.pdf' }), image(IMAGE_AID))),
      [signedAttachmentPath]: pdfBytes,
      [`GET /api/shared/${NOTE_ID}/attachments/${IMAGE_AID}?exp=${EXP}&sig=${SIG}`]: {
        body: 'image-bytes',
        headers: { 'content-type': 'image/png' },
      },
      [`GET ${BLOB_1}`]: pdfBytes,
      'GET blob:http://localhost/2': pdfBytes,
    })
    renderApp(`/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`)
    await screen.findByText('Page 1 of 1')

    const types = vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) => (blob as Blob).type).sort()
    expect(types).toEqual(['application/octet-stream', 'image/png'])
  })

  it("downloading a PDF the viewer already loaded reuses its blob and the response's stored name", async () => {
    stubPdf(1)
    const clicked = captureDownloads()
    const named = { ...pdfBytes, headers: { ...pdfBytes.headers, 'content-disposition': `attachment; filename="Route.pdf"` } }
    const { requests } = mockFetch({
      [signedNotePath]: sharedNote(doc(fileNode(attachmentSrc(AID), { kind: 'pdf', name: 'guide.pdf' }))),
      [signedAttachmentPath]: named,
      [`GET ${BLOB_1}`]: pdfBytes,
    })
    renderApp(`/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`)
    await screen.findByText('Page 1 of 1')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Download guide.pdf' }))
    await waitFor(() => expect(clicked).toEqual([{ href: BLOB_1, download: 'Route.pdf', connected: true }]))
    expect(requests.filter((r) => `${r.method} ${r.path}` === signedAttachmentPath)).toHaveLength(1)
  })

  it('a failed download can be retried: the failure is not cached', async () => {
    const clicked = captureDownloads()
    let calls = 0
    mockFetch({
      [signedNotePath]: sharedNote(doc(fileNode(attachmentSrc(AID), { kind: 'gpx', name: 'ride.gpx' }))),
      [signedAttachmentPath]: () =>
        ++calls === 1 ? unavailable : namedGpx('ride.gpx'),
    })
    renderApp(`/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`)

    const user = userEvent.setup()
    const button = await screen.findByRole('button', { name: 'Download ride.gpx' })
    await user.click(button)
    expect(await screen.findByText('Could not download ride.gpx. Try again in a moment.')).toBeInTheDocument()
    expect(clicked).toEqual([])

    await user.click(button)
    await waitFor(() => expect(clicked).toEqual([{ href: BLOB_1, download: 'ride.gpx', connected: true }]))
    expect(calls).toBe(2)
  })

  it('an attachment fetch still running when the page unmounts never creates a blob URL', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    mockFetch({
      [signedNotePath]: sharedNote(doc(image(AID))),
      [signedAttachmentPath]: async () => {
        await held
        return { body: 'image-bytes', headers: { 'content-type': 'image/png' } }
      },
    })
    const { unmount } = renderApp(`/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`)
    await screen.findByRole('heading', { name: 'Trip plan' })
    unmount()

    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('a PDF that cannot be fetched shows the viewer error state, not the unavailable page; Download reports its failure', async () => {
    const clicked = captureDownloads()
    mockFetch({
      [signedNotePath]: sharedNote(doc(paragraph('Still here'), fileNode(attachmentSrc(AID), { kind: 'pdf', name: 'guide.pdf' }))),
      [signedAttachmentPath]: unavailable,
    })
    renderApp(`/shared/${NOTE_ID}?exp=${EXP}&sig=${SIG}`)

    expect(await screen.findByText('Preview unavailable, download instead')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Trip plan' })).toBeInTheDocument()
    expect(screen.getByLabelText('Shared note content')).toHaveTextContent('Still here')
    expect(screen.queryByTestId('shared-unavailable')).not.toBeInTheDocument()
    expect(loadPdfMock).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Download guide.pdf' }))
    expect(await screen.findByText('Could not download guide.pdf. Try again in a moment.')).toBeInTheDocument()
    expect(clicked).toEqual([])
    expect(screen.queryByTestId('shared-unavailable')).not.toBeInTheDocument()
  })
})
