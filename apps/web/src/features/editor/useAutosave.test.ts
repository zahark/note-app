import { createElement, StrictMode, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { Editor, JSONContent } from '@tiptap/core'
import { act, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { createQueryClient } from '@/lib/queryClient'
import { mockFetch, renderApp, renderWithProviders, testUser, unauthorizedResponse, type MockResponse } from '@/test/utils'
import { flushAllSaves } from './api'
import { NotePane } from './NotePane'
import { Autosaver, useAutosave, type SaveStatus } from './useAutosave'

const NOTE_ID = '11111111-1111-4111-8111-111111111111'

const text = (value: string): JSONContent => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
})

/** A save function whose calls stay pending until the test settles them. */
function controlledSave() {
  const calls: { content: JSONContent; version: number; resolve: (v: number) => void; reject: (e: unknown) => void }[] = []
  const save = vi.fn(
    (content: JSONContent, version: number) =>
      new Promise<{ version: number }>((resolve, reject) => {
        calls.push({ content, version, resolve: (v) => resolve({ version: v }), reject })
      }),
  )
  return { save, calls }
}

function makeSaver(save: ReturnType<typeof controlledSave>['save'], version = 1) {
  const statuses: SaveStatus[] = []
  const saver = new Autosaver({ version, save, onStatus: (s) => statuses.push(s) })
  return { saver, statuses }
}

/** Lets settled promises run their continuations. */
const flushPromises = () => act(async () => {})

describe('Autosaver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('debounces to 1s after the last change and sends the latest content with the version', async () => {
    const { save, calls } = controlledSave()
    const { saver, statuses } = makeSaver(save, 3)

    saver.schedule(text('a'))
    vi.advanceTimersByTime(600)
    saver.schedule(text('ab'))
    vi.advanceTimersByTime(999)
    expect(save).not.toHaveBeenCalled()
    expect(statuses).toEqual(['pending'])

    vi.advanceTimersByTime(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(calls[0]!.content).toEqual(text('ab'))
    expect(calls[0]!.version).toBe(3)
    expect(statuses).toEqual(['pending', 'saving'])

    calls[0]!.resolve(4)
    await flushPromises()
    expect(statuses).toEqual(['pending', 'saving', 'saved'])
    // the next save is based on the version the server returned
    saver.schedule(text('abc'))
    vi.advanceTimersByTime(1000)
    expect(calls[1]!.version).toBe(4)
  })

  it('never starts a save while one is in flight, then sends the latest content with the returned version', async () => {
    const { save, calls } = controlledSave()
    const { saver, statuses } = makeSaver(save, 1)

    saver.schedule(text('first'))
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)

    saver.schedule(text('second'))
    vi.advanceTimersByTime(1000)
    saver.schedule(text('third'))
    vi.advanceTimersByTime(1000)
    // both debounces elapsed, but the first save is still in flight
    expect(save).toHaveBeenCalledTimes(1)
    expect(statuses.at(-1)).toBe('saving')

    calls[0]!.resolve(2)
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(2)
    expect(calls[1]!.content).toEqual(text('third'))
    expect(calls[1]!.version).toBe(2)

    calls[1]!.resolve(3)
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(2)
    expect(statuses.at(-1)).toBe('saved')
    saver.schedule(text('fourth'))
    saver.flush()
    expect(calls[2]!.version).toBe(3)
  })

  it('a change made during a save whose debounce has not elapsed waits for it', async () => {
    const { save, calls } = controlledSave()
    const { saver, statuses } = makeSaver(save)

    saver.schedule(text('a'))
    vi.advanceTimersByTime(1000)
    saver.schedule(text('b'))
    calls[0]!.resolve(2)
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(1)
    expect(statuses.at(-1)).toBe('pending')

    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(2)
    expect(calls[1]).toMatchObject({ content: text('b'), version: 2 })
  })

  it('a failed save shows error, keeps the content and retries it', async () => {
    const { save, calls } = controlledSave()
    const { saver, statuses } = makeSaver(save, 5)

    saver.schedule(text('keep me'))
    vi.advanceTimersByTime(1000)
    calls[0]!.reject(new ApiError(500, 'INTERNAL', 'boom'))
    await flushPromises()
    expect(statuses.at(-1)).toBe('error')
    expect(saver.hasUnsavedChanges).toBe(true)

    vi.advanceTimersByTime(5000)
    expect(save).toHaveBeenCalledTimes(2)
    expect(calls[1]).toMatchObject({ content: text('keep me'), version: 5 })
    calls[1]!.resolve(6)
    await flushPromises()
    expect(statuses.at(-1)).toBe('saved')
  })

  it('retries a rate-limited save (429) on the retry timer', async () => {
    const { save, calls } = controlledSave()
    const { saver, statuses } = makeSaver(save, 3)

    saver.schedule(text('limited'))
    vi.advanceTimersByTime(1000)
    calls[0]!.reject(new ApiError(429, 'RATE_LIMITED', 'Too many saves, try again in a few minutes'))
    await flushPromises()
    expect(statuses.at(-1)).toBe('error')
    expect(saver.hasUnsavedChanges).toBe(true)

    vi.advanceTimersByTime(5000)
    expect(calls[1]).toMatchObject({ content: text('limited'), version: 3 })
    calls[1]!.resolve(4)
    await flushPromises()
    expect(statuses.at(-1)).toBe('saved')
  })

  it('a retry sends newer content when the user kept typing', async () => {
    const { save, calls } = controlledSave()
    const { saver } = makeSaver(save)

    saver.schedule(text('old'))
    vi.advanceTimersByTime(1000)
    saver.schedule(text('newer'))
    calls[0]!.reject(new ApiError(0, 'NETWORK_ERROR', 'offline'))
    await flushPromises()
    vi.advanceTimersByTime(1000)
    expect(calls[1]!.content).toEqual(text('newer'))
  })

  it('does not retry a failure that would fail again (e.g. the note was deleted)', async () => {
    const { save, calls } = controlledSave()
    const onError = vi.fn()
    const statuses: SaveStatus[] = []
    const saver = new Autosaver({ version: 1, save, onStatus: (s) => statuses.push(s), onError })

    saver.schedule(text('x'))
    vi.advanceTimersByTime(1000)
    const err = new ApiError(404, 'NOT_FOUND', 'Note not found')
    calls[0]!.reject(err)
    await flushPromises()
    expect(statuses.at(-1)).toBe('error')
    expect(onError).toHaveBeenCalledWith(err)
    vi.advanceTimersByTime(60_000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('a 409 stops saving with a conflict status', async () => {
    const { save, calls } = controlledSave()
    const { saver, statuses } = makeSaver(save)

    saver.schedule(text('mine'))
    vi.advanceTimersByTime(1000)
    calls[0]!.reject(new ApiError(409, 'VERSION_CONFLICT', 'changed elsewhere'))
    await flushPromises()
    expect(statuses.at(-1)).toBe('conflict')

    saver.schedule(text('more'))
    saver.flush()
    vi.advanceTimersByTime(60_000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(statuses.at(-1)).toBe('conflict')
  })

  it('flush saves pending content at once', () => {
    const { save } = controlledSave()
    const { saver } = makeSaver(save)
    saver.schedule(text('now'))
    saver.flush()
    expect(save).toHaveBeenCalledTimes(1)
  })
})

function renderAutosave(version = 7) {
  const client = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
  return renderHook(() => useAutosave({ noteId: NOTE_ID, version }), { wrapper })
}

/** Sets `document.visibilityState` (jsdom keeps it `visible`) and fires `visibilitychange`. */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useAutosave', () => {
  afterEach(() => {
    // back to jsdom's own getter on Document.prototype
    Reflect.deleteProperty(document, 'visibilityState')
  })

  it('sends only {content, version} to PUT /api/notes/:id/content (never the title) and flushes on unmount', async () => {
    const { requests } = mockFetch({ [`PUT /api/notes/${NOTE_ID}/content`]: { body: { version: 8 } } })
    const { result, unmount } = renderAutosave()

    act(() => result.current.schedule(text('hello')))
    expect(result.current.status).toBe('pending')
    // leaving the note does not wait for the debounce
    unmount()
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]!.method).toBe('PUT')
    expect(requests[0]!.path).toBe(`/api/notes/${NOTE_ID}/content`)
    expect(Object.keys(requests[0]!.body as object).sort()).toEqual(['content', 'version'])
    expect(requests[0]!.body).toEqual({ content: text('hello'), version: 7 })
  })

  it('saves pending content at once when the tab is hidden', async () => {
    const { requests } = mockFetch({ [`PUT /api/notes/${NOTE_ID}/content`]: { body: { version: 8 } } })
    const { result } = renderAutosave()

    act(() => result.current.schedule(text('typed just now')))
    act(() => setVisibility('visible'))
    expect(requests).toHaveLength(0)
    act(() => setVisibility('hidden'))
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]!.body).toEqual({ content: text('typed just now'), version: 7 })
    await waitFor(() => expect(result.current.status).toBe('saved'))
  })

  it('asks before the tab closes with unsaved changes, and saves them', async () => {
    const { requests } = mockFetch({ [`PUT /api/notes/${NOTE_ID}/content`]: { body: { version: 8 } } })
    const { result } = renderAutosave()

    act(() => result.current.schedule(text('unsaved')))
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]!.body).toEqual({ content: text('unsaved'), version: 7 })
  })

  it('lets the tab close without asking when everything is saved', async () => {
    const { requests } = mockFetch({ [`PUT /api/notes/${NOTE_ID}/content`]: { body: { version: 8 } } })
    const { result } = renderAutosave()

    const untouched = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(untouched)
    expect(untouched.defaultPrevented).toBe(false)

    act(() => result.current.schedule(text('x')))
    act(() => setVisibility('hidden'))
    await waitFor(() => expect(result.current.status).toBe('saved'))
    const afterSave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(afterSave)
    expect(afterSave.defaultPrevented).toBe(false)
    expect(requests).toHaveLength(1)
  })
})

// --- the save status and the conflict prompt, as the editor shows them ---

const note = (content: JSONContent, version = 1) => ({
  id: NOTE_ID,
  folder_id: null,
  title: 'My note',
  version,
  created_at: 1,
  updated_at: 1,
  share_type: 'private' as const,
  expires_at: null,
  content,
})

const treeResponse: MockResponse = { body: { folders: [], notes: [note(text(''))].map(({ content: _c, ...n }) => n) } }

/** The TipTap editor rendered for the open note. */
async function findEditor(): Promise<Editor> {
  const el = await screen.findByLabelText('Note content')
  const editor = (el as HTMLElement & { editor?: Editor }).editor
  expect(editor).toBeDefined()
  return editor!
}

describe('editor save status and conflict prompt', () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  afterEach(() => {
    // the conflict test replaces navigator.clipboard; vi.unstubAllGlobals does not undo defineProperty
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('shows Saved, then Saving… while a change is pending or in flight, then Saved', async () => {
    let release!: () => void
    mockFetch({
      'GET /api/tree': treeResponse,
      [`GET /api/notes/${NOTE_ID}`]: { body: { note: note(text('start')) } },
      [`PUT /api/notes/${NOTE_ID}/content`]: () =>
        new Promise<MockResponse>((resolve) => (release = () => resolve({ body: { version: 2 } }))),
    })
    renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose: () => {} }))
    const editor = await findEditor()
    const status = screen.getByRole('status', { name: 'Save status' })
    expect(status).toHaveTextContent('Saved')

    act(() => void editor.commands.insertContent(' more'))
    expect(status).toHaveTextContent('Saving…')
    await waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 3000 })
    expect(status).toHaveTextContent('Saving…')
    act(() => release())
    await waitFor(() => expect(status).toHaveTextContent('Saved'))
  })

  it('shows Error when a save fails', async () => {
    let failures = 0
    mockFetch({
      'GET /api/tree': treeResponse,
      [`GET /api/notes/${NOTE_ID}`]: { body: { note: note(text('start')) } },
      // fails once; the retry (or the flush on unmount) succeeds, so no saver keeps retrying into later tests
      [`PUT /api/notes/${NOTE_ID}/content`]: () =>
        failures++ === 0
          ? { status: 500, body: { error: { code: 'INTERNAL', message: 'Server error' } } }
          : { body: { version: 2 } },
    })
    renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose: () => {} }))
    const editor = await findEditor()

    act(() => void editor.commands.insertContent(' more'))
    await waitFor(() => expect(screen.getByRole('status', { name: 'Save status' })).toHaveTextContent('Error saving'), {
      timeout: 3000,
    })
  })

  it('shows the server message when a save fails for good (e.g. the note is too large)', async () => {
    const { requests } = mockFetch({
      'GET /api/tree': treeResponse,
      [`GET /api/notes/${NOTE_ID}`]: { body: { note: note(text('start')) } },
      [`PUT /api/notes/${NOTE_ID}/content`]: {
        status: 413,
        body: { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Note is too large' } },
      },
    })
    renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose: () => {} }))
    const editor = await findEditor()

    act(() => void editor.commands.insertContent(' more'))
    const status = screen.getByRole('status', { name: 'Save status' })
    await waitFor(() => expect(status).toHaveTextContent('Not saved: Note is too large'), { timeout: 3000 })
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1)
  })

  it('a lost session during autosave sends the user to the login page', async () => {
    mockFetch({
      'GET /api/auth/me': { body: { user: testUser } },
      'GET /api/tree': treeResponse,
      [`GET /api/notes/${NOTE_ID}`]: { body: { note: note(text('start')) } },
      [`PUT /api/notes/${NOTE_ID}/content`]: unauthorizedResponse,
    })
    renderApp(`/?note=${NOTE_ID}`)
    const editor = await findEditor()

    act(() => void editor.commands.insertContent(' more'))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'), { timeout: 3000 })
  })

  it('a 409 shows a reload prompt that copies the local content, then reloads the server version', async () => {
    let serverNote = note(text('original'), 1)
    const { requests } = mockFetch({
      'GET /api/tree': treeResponse,
      [`GET /api/notes/${NOTE_ID}`]: () => ({ body: { note: serverNote } }),
      [`PUT /api/notes/${NOTE_ID}/content`]: () => {
        // someone else saved in the meantime
        serverNote = note(text('from another device'), 5)
        return { status: 409, body: { error: { code: 'VERSION_CONFLICT', message: 'changed elsewhere' } } }
      },
    })
    const writeText = vi.fn(async (_text: string) => {})
    const write = vi.fn(async (_items: ClipboardItem[]) => {})
    vi.stubGlobal('ClipboardItem', class {
      readonly items: Record<string, Blob>
      constructor(items: Record<string, Blob>) {
        this.items = items
      }
    })

    renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose: () => {} }))
    const editor = await findEditor()
    act(() => void editor.commands.insertContent('my local edit '))

    const alert = await screen.findByRole('alert', {}, { timeout: 3000 })
    expect(alert).toHaveTextContent(/changed somewhere else/i)
    expect(screen.getByRole('status', { name: 'Save status' })).toHaveTextContent('Not saved')
    // further edits would never be saved
    expect(editor.isEditable).toBe(false)

    // after userEvent.setup(), which installs its own clipboard stub
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', { value: { write, writeText }, configurable: true })
    await user.click(screen.getByRole('button', { name: 'Copy my version' }))
    expect(write).toHaveBeenCalledTimes(1)
    const item = write.mock.calls[0]![0][0] as unknown as { items: Record<string, Blob> }
    expect(await item.items['text/plain']!.text()).toContain('my local edit')
    expect(await item.items['text/html']!.text()).toContain('my local edit')

    await user.click(screen.getByRole('button', { name: 'Reload note' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    const reloaded = await findEditor()
    await waitFor(() => expect(reloaded.getText()).toContain('from another device'))
    expect(reloaded.isEditable).toBe(true)
    expect(requests.filter((r) => r.method === 'GET' && r.path === `/api/notes/${NOTE_ID}`)).toHaveLength(2)
  })

  it('after a reload, saves use the reloaded version', async () => {
    let serverNote = note(text('original'), 1)
    let conflictOnce = true
    const { requests } = mockFetch({
      'GET /api/tree': treeResponse,
      [`GET /api/notes/${NOTE_ID}`]: () => ({ body: { note: serverNote } }),
      [`PUT /api/notes/${NOTE_ID}/content`]: () => {
        if (conflictOnce) {
          conflictOnce = false
          serverNote = note(text('newer'), 9)
          return { status: 409, body: { error: { code: 'VERSION_CONFLICT', message: 'changed elsewhere' } } }
        }
        return { body: { version: 10 } }
      },
    })
    renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose: () => {} }))
    const editor = await findEditor()
    act(() => void editor.commands.insertContent('x'))
    await screen.findByRole('alert', {}, { timeout: 3000 })
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload note' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())

    const reloaded = await findEditor()
    act(() => void reloaded.commands.insertContent('y'))
    await waitFor(() => expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(2), { timeout: 3000 })
    expect((requests.filter((r) => r.method === 'PUT')[1]!.body as { version: number }).version).toBe(9)
  })
})

// --- reopening a note while its last save is still in flight ---

/** A content PUT handler holding every save until the test releases it; the server note follows each save. */
function heldSaves(initial: JSONContent) {
  let serverNote = note(initial, 1)
  const held: (() => void)[] = []
  const handler = (req: { body: unknown }) =>
    new Promise<MockResponse>((resolve) => {
      held.push(() => {
        const { content, version } = req.body as { content: JSONContent; version: number }
        serverNote = note(content, version + 1)
        resolve({ body: { version: version + 1 } })
      })
    })
  return { held, handler, getNote: () => ({ body: { note: serverNote } }) }
}

const noteGets = (requests: { method: string; path: string }[]) =>
  requests.filter((r) => r.method === 'GET' && r.path === `/api/notes/${NOTE_ID}`)

/** Lets queued timers and promise continuations run (e.g. a fetch the code under test might start). */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))

describe('reopening a note', () => {
  it('waits for the save sent on leaving before loading the note again', async () => {
    const saves = heldSaves(text('start'))
    const { requests } = mockFetch({
      'GET /api/tree': treeResponse,
      [`GET /api/notes/${NOTE_ID}`]: saves.getNote,
      [`PUT /api/notes/${NOTE_ID}/content`]: saves.handler,
    })
    const first = renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose: () => {} }))
    const editor = await findEditor()
    act(() => void editor.commands.insertContent('typed '))
    // leaving the note flushes the edit; the save is still in flight
    first.unmount()
    await waitFor(() => expect(saves.held).toHaveLength(1))

    renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose: () => {} }))
    await settle()
    expect(noteGets(requests)).toHaveLength(1)
    expect(screen.getByRole('status', { name: 'Loading note' })).toBeInTheDocument()

    act(() => saves.held[0]!())
    const reopened = await findEditor()
    expect(reopened.getText()).toContain('typed start')
    expect(noteGets(requests)).toHaveLength(2)
  })

  it('also waits for a save queued behind the one in flight', async () => {
    const saves = heldSaves(text('start'))
    const { requests } = mockFetch({
      'GET /api/tree': treeResponse,
      [`GET /api/notes/${NOTE_ID}`]: saves.getNote,
      [`PUT /api/notes/${NOTE_ID}/content`]: saves.handler,
    })
    const first = renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose: () => {} }))
    const editor = await findEditor()
    act(() => void editor.commands.insertContent('one '))
    // the debounced save goes out and is held
    await waitFor(() => expect(saves.held).toHaveLength(1), { timeout: 3000 })
    act(() => void editor.commands.insertContent('two '))
    // leaving queues a flush behind the save in flight
    first.unmount()

    renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose: () => {} }))
    act(() => saves.held[0]!())
    // the queued save starts as soon as the first one ends; the note is still not loaded
    await waitFor(() => expect(saves.held).toHaveLength(2))
    await settle()
    expect(noteGets(requests)).toHaveLength(1)

    act(() => saves.held[1]!())
    const reopened = await findEditor()
    expect(reopened.getText()).toContain('one two start')
    expect(requests.filter((r) => r.method === 'PUT').map((r) => (r.body as { version: number }).version)).toEqual([1, 2])
  })
})

describe('signing out with unsaved edits', () => {
  it('saves the open note before the session ends', async () => {
    const { requests } = mockFetch({
      'GET /api/auth/me': { body: { user: testUser } },
      'GET /api/tree': treeResponse,
      [`GET /api/notes/${NOTE_ID}`]: { body: { note: note(text('start')) } },
      [`PUT /api/notes/${NOTE_ID}/content`]: { body: { version: 2 } },
      'POST /api/auth/logout': { status: 204 },
    })
    renderApp(`/?note=${NOTE_ID}`)
    const editor = await findEditor()
    act(() => void editor.commands.insertContent('last words '))

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(await screen.findByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'))

    const put = requests.findIndex((r) => r.method === 'PUT')
    const logout = requests.findIndex((r) => r.path === '/api/auth/logout')
    expect(put).toBeGreaterThanOrEqual(0)
    expect(put).toBeLessThan(logout)
    expect(JSON.stringify(requests[put]!.body)).toContain('last words')
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1)
  })
})

// --- a closed note whose last save failed: the saver keeps working until its edits are saved ---

const unavailable: MockResponse = { status: 503, body: { error: { code: 'INTERNAL', message: 'Service unavailable' } } }

/** Dispatches `beforeunload` and tells whether the page asked to stay. */
function unloadPrompted(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe('a closed note whose last save failed', () => {
  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState')
  })

  it('still asks before the tab closes, is saved before signing out, then lets go', async () => {
    let failing = true
    const { requests } = mockFetch({
      [`PUT /api/notes/${NOTE_ID}/content`]: () => (failing ? unavailable : { body: { version: 8 } }),
    })
    const { result, unmount } = renderAutosave()
    act(() => result.current.schedule(text('offline edit')))
    // leaving the note flushes the edit, and that save fails
    unmount()
    await waitFor(() => expect(requests).toHaveLength(1))
    await settle()

    // the unload prompt still covers the closed note, and retries its save
    expect(unloadPrompted()).toBe(true)
    await waitFor(() => expect(requests).toHaveLength(2))
    await settle()

    // signing out sends the closed note's edits too
    failing = false
    await act(() => flushAllSaves())
    expect(requests).toHaveLength(3)
    expect(requests[2]!.body).toEqual({ content: text('offline edit'), version: 7 })

    // saved: nothing is left to protect
    await settle()
    expect(unloadPrompted()).toBe(false)
  })

  it('reopening the note waits until the retried save succeeds, then continues from its version', async () => {
    let failing = true
    let serverNote = note(text('start'), 1)
    const { requests } = mockFetch({
      'GET /api/tree': treeResponse,
      [`GET /api/notes/${NOTE_ID}`]: () => ({ body: { note: serverNote } }),
      [`PUT /api/notes/${NOTE_ID}/content`]: (req) => {
        if (failing) return unavailable
        const { content, version } = req.body as { content: JSONContent; version: number }
        serverNote = note(content, version + 1)
        return { body: { version: version + 1 } }
      },
    })
    const puts = () => requests.filter((r) => r.method === 'PUT')
    const first = renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose: () => {} }))
    const editor = await findEditor()
    act(() => void editor.commands.insertContent('typed '))
    first.unmount()
    await waitFor(() => expect(puts()).toHaveLength(1))
    await settle()

    // reopening retries the save at once; while it keeps failing the note is not loaded
    renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose: () => {} }))
    await waitFor(() => expect(puts()).toHaveLength(2))
    await settle()
    expect(noteGets(requests)).toHaveLength(1)
    expect(screen.getByRole('status', { name: 'Loading note' })).toBeInTheDocument()

    // back online: hiding the tab retries now; once saved, the note loads with the edit
    failing = false
    act(() => setVisibility('hidden'))
    const reopened = await findEditor()
    expect(reopened.getText()).toContain('typed start')
    expect(noteGets(requests)).toHaveLength(2)

    // the next edit is based on the version that save produced, so it does not conflict
    act(() => void reopened.commands.insertContent('more '))
    await waitFor(() => expect(puts()).toHaveLength(4), { timeout: 3000 })
    expect((puts()[3]!.body as { version: number }).version).toBe(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('an editor whose effects run twice (StrictMode) stays registered', async () => {
    mockFetch({ [`PUT /api/notes/${NOTE_ID}/content`]: { body: { version: 8 } } })
    const client = createQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, createElement(QueryClientProvider, { client }, children))
    const { result } = renderHook(() => useAutosave({ noteId: NOTE_ID, version: 7 }), { wrapper })
    await settle()
    act(() => result.current.schedule(text('typed')))
    expect(unloadPrompted()).toBe(true)
  })

  it('lets go of edits that can never be saved and says so', async () => {
    const error = vi.spyOn(toast, 'error')
    const { requests } = mockFetch({
      [`PUT /api/notes/${NOTE_ID}/content`]: {
        status: 413,
        body: { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Note is too large' } },
      },
    })
    const { result, unmount } = renderAutosave()
    act(() => result.current.schedule(text('huge')))
    unmount()
    await waitFor(() => expect(requests).toHaveLength(1))
    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining('Note is too large')))
    await settle()
    expect(unloadPrompted()).toBe(false)
  })
})
