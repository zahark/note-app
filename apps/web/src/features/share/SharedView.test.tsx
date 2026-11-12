import type { JSONContent } from '@tiptap/core'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockFetch, renderApp, type MockResponse, type RecordedRequest } from '@/test/utils'
import { GENERIC_UNLOCK_ERROR } from './LockScreen'

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

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const paragraph = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const image = (aid: string): JSONContent => ({ type: 'image', attrs: { src: `attachment://${aid}` } })

const sharedNote = (content: JSONContent = doc(paragraph('Shared body'))): MockResponse => ({
  body: { note: { title: 'Trip plan', content, attachment_ids: [AID] } },
})

const headersOf = (req: RecordedRequest) => (req.init.headers ?? {}) as Record<string, string>

let blobCount = 0
beforeEach(() => {
  blobCount = 0
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
    mockFetch(routes)
    const { unmount } = renderApp(path)
    if (pin) await unlockWith(pin)
    const markup = (await screen.findByTestId('shared-unavailable')).outerHTML
    unmount()
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
