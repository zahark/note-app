import { createElement, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import type { Editor, JSONContent } from '@tiptap/core'
import { act, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { createQueryClient } from '@/lib/queryClient'
import { mockFetch, renderWithProviders, type MockResponse } from '@/test/utils'
import { NotePane } from './Editor'
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
  const saver = new Autosaver({ version, save, onStatus: (s) => statuses.push(s), delay: 1000, retryDelay: 5000 })
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
    expect(saver.currentVersion).toBe(4)
  })

  it('never starts a save while one is in flight, then sends the latest content with the returned version', async () => {
    const { save, calls } = controlledSave()
    const { saver } = makeSaver(save, 1)

    saver.schedule(text('first'))
    vi.advanceTimersByTime(1000)
    expect(save).toHaveBeenCalledTimes(1)

    saver.schedule(text('second'))
    vi.advanceTimersByTime(1000)
    saver.schedule(text('third'))
    vi.advanceTimersByTime(1000)
    // both debounces elapsed, but the first save is still in flight
    expect(save).toHaveBeenCalledTimes(1)
    expect(saver.currentStatus).toBe('saving')

    calls[0]!.resolve(2)
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(2)
    expect(calls[1]!.content).toEqual(text('third'))
    expect(calls[1]!.version).toBe(2)

    calls[1]!.resolve(3)
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(2)
    expect(saver.currentStatus).toBe('saved')
    expect(saver.currentVersion).toBe(3)
  })

  it('a change made during a save whose debounce has not elapsed waits for it', async () => {
    const { save, calls } = controlledSave()
    const { saver } = makeSaver(save)

    saver.schedule(text('a'))
    vi.advanceTimersByTime(1000)
    saver.schedule(text('b'))
    calls[0]!.resolve(2)
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(1)
    expect(saver.currentStatus).toBe('pending')

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
    expect(saver.currentStatus).toBe('error')
    expect(saver.hasUnsavedChanges).toBe(true)

    vi.advanceTimersByTime(5000)
    expect(save).toHaveBeenCalledTimes(2)
    expect(calls[1]).toMatchObject({ content: text('keep me'), version: 5 })
    calls[1]!.resolve(6)
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
    const saver = new Autosaver({ version: 1, save, onStatus: () => {}, onError })

    saver.schedule(text('x'))
    vi.advanceTimersByTime(1000)
    const err = new ApiError(404, 'NOT_FOUND', 'Note not found')
    calls[0]!.reject(err)
    await flushPromises()
    expect(saver.currentStatus).toBe('error')
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
    expect(saver.currentStatus).toBe('conflict')
  })

  it('flush saves pending content at once', () => {
    const { save } = controlledSave()
    const { saver } = makeSaver(save)
    saver.schedule(text('now'))
    saver.flush()
    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe('useAutosave', () => {
  it('sends only {content, version} to PUT /api/notes/:id/content (never the title) and flushes on unmount', async () => {
    const { requests } = mockFetch({ [`PUT /api/notes/${NOTE_ID}/content`]: { body: { version: 8 } } })
    const client = createQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const { result, unmount } = renderHook(() => useAutosave({ noteId: NOTE_ID, version: 7 }), { wrapper })

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
    mockFetch({
      'GET /api/tree': treeResponse,
      [`GET /api/notes/${NOTE_ID}`]: { body: { note: note(text('start')) } },
      [`PUT /api/notes/${NOTE_ID}/content`]: {
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'Server error' } },
      },
    })
    renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose: () => {} }))
    const editor = await findEditor()

    act(() => void editor.commands.insertContent(' more'))
    await waitFor(() => expect(screen.getByRole('status', { name: 'Save status' })).toHaveTextContent('Error saving'), {
      timeout: 3000,
    })
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
