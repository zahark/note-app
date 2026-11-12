import { createElement } from 'react'
import type { Editor, JSONContent } from '@tiptap/core'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { TreeData } from '@/features/tree/buildTree'
import { treeQueryKey } from '@/features/tree/api'
import { mockFetch, renderApp, renderWithProviders, testUser, type MockResponse } from '@/test/utils'
import { NotePane } from './Editor'

const NOTE_ID = '22222222-2222-4222-8222-222222222222'
const AID = '0b4c2f7e-1d2a-4c3b-9e8f-0123456789ab'
const AID2 = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const text = (value: string): JSONContent => doc({ type: 'paragraph', content: [{ type: 'text', text: value }] })

const summary = (title = 'My note') => ({
  id: NOTE_ID,
  folder_id: null,
  title,
  version: 1,
  created_at: 1,
  updated_at: 1,
  share_type: 'private' as const,
  expires_at: null,
})
const fullNote = (content: JSONContent, title = 'My note') => ({ ...summary(title), content })
const treeWith = (title = 'My note'): MockResponse => ({ body: { folders: [], notes: [summary(title)] } })

function renderPane(onClose = () => {}) {
  return renderWithProviders(createElement(NotePane, { noteId: NOTE_ID, onClose }))
}

async function findEditor(): Promise<Editor> {
  const el = await screen.findByLabelText('Note content')
  return (el as HTMLElement & { editor: Editor }).editor
}

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

const png = (name = 'cat.png') => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })

/** A paste/drop event carrying files, the way the browser delivers them. */
function fileEvent(type: 'paste' | 'drop', files: File[], coords = { clientX: 0, clientY: 0 }) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const data = { files, types: ['Files'], getData: () => '', setData: () => {}, clearData: () => {}, items: [] }
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: data })
  Object.assign(event, coords)
  return event
}

describe('note loading and empty states', () => {
  it('shows a skeleton while loading, then the title and content', async () => {
    let release!: () => void
    mockFetch({
      'GET /api/tree': treeWith(),
      [`GET /api/notes/${NOTE_ID}`]: () =>
        new Promise<MockResponse>((resolve) => (release = () => resolve({ body: { note: fullNote(text('Hello')) } }))),
    })
    renderPane()
    expect(await screen.findByRole('status', { name: 'Loading note' })).toBeInTheDocument()
    await waitFor(() => expect(release).toBeTypeOf('function'))
    act(() => release())

    const editor = await findEditor()
    expect(screen.queryByRole('status', { name: 'Loading note' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Note title')).toHaveValue('My note')
    expect(editor.getText()).toBe('Hello')
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument()
  })

  it('an empty note shows the writing placeholder and an empty title shows Untitled', async () => {
    mockFetch({
      'GET /api/tree': treeWith(''),
      [`GET /api/notes/${NOTE_ID}`]: { body: { note: fullNote(doc(), '') } },
    })
    renderPane()
    await findEditor()
    const title = screen.getByLabelText('Note title')
    expect(title).toHaveValue('')
    expect(title).toHaveAttribute('placeholder', 'Untitled')
    await waitFor(() =>
      expect(document.querySelector('.is-editor-empty')).toHaveAttribute('data-placeholder', 'Start writing…'),
    )
  })

  it('a missing note says so and can be closed', async () => {
    mockFetch({ 'GET /api/tree': treeWith() })
    const onClose = vi.fn()
    renderPane(onClose)
    expect(await screen.findByText('This note does not exist or was deleted.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('a failed load offers a retry', async () => {
    let fail = true
    mockFetch({
      'GET /api/tree': treeWith(),
      [`GET /api/notes/${NOTE_ID}`]: () =>
        fail
          ? { status: 400, body: { error: { code: 'BAD', message: 'bad' } } }
          : { body: { note: fullNote(text('Back')) } },
    })
    renderPane()
    expect(await screen.findByText('Could not load this note.')).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect((await findEditor()).getText()).toBe('Back')
  })

  it('opening ?note=<id> in the app shows the note; without it the pane asks to pick one', async () => {
    mockFetch({
      'GET /api/auth/me': { body: { user: testUser } },
      'GET /api/tree': treeWith(),
      [`GET /api/notes/${NOTE_ID}`]: { body: { note: fullNote(text('In the app')) } },
    })
    renderApp(`/?note=${NOTE_ID}`)
    expect((await findEditor()).getText()).toBe('In the app')

    const other = renderApp('/')
    expect(await other.findByText('Select a note or create a new one.')).toBeInTheDocument()
  })
})

describe('title field', () => {
  function setup(title = 'My note') {
    const fetch = mockFetch({
      'GET /api/tree': treeWith(title),
      [`GET /api/notes/${NOTE_ID}`]: { body: { note: fullNote(text('Body'), title) } },
      [`PATCH /api/notes/${NOTE_ID}`]: (req) => ({ body: { note: summary((req.body as { title: string }).title) } }),
    })
    return { ...fetch, ...renderPane() }
  }

  it('saves the title through PATCH /api/notes/:id {title} on blur, not through autosave', async () => {
    const { requests, client } = setup()
    await findEditor()
    const user = userEvent.setup()
    const input = screen.getByLabelText('Note title')
    await user.clear(input)
    await user.type(input, 'Renamed')
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false)
    await user.tab()

    await waitFor(() => expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(1))
    const patch = requests.find((r) => r.method === 'PATCH')!
    expect(patch.path).toBe(`/api/notes/${NOTE_ID}`)
    expect(patch.body).toEqual({ title: 'Renamed' })
    // the sidebar's tree shows the new title at once
    expect(client.getQueryData<TreeData>(treeQueryKey)!.notes[0]!.title).toBe('Renamed')
    // a title change is never sent as content
    await new Promise((r) => setTimeout(r, 1200))
    expect(requests.some((r) => r.method === 'PUT')).toBe(false)
  })

  it('Enter saves and moves to the content; Escape cancels; an unchanged title sends nothing', async () => {
    const { requests } = setup()
    const editor = await findEditor()
    const user = userEvent.setup()
    const input = screen.getByLabelText('Note title')

    await user.click(input)
    await user.type(input, ' draft{Escape}')
    expect(input).toHaveValue('My note')
    await user.tab()
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false)

    await user.click(input)
    await user.type(input, '!{Enter}')
    await waitFor(() => expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ title: 'My note!' }))
    await waitFor(() => expect(document.activeElement).toBe(editor.view.dom))
  })

  it('shows a rename made in the sidebar while the note is open', async () => {
    const { client } = setup()
    await findEditor()
    await waitFor(() => expect(client.getQueryData(treeQueryKey)).toBeDefined())
    act(() =>
      client.setQueryData<TreeData>(treeQueryKey, (tree) => ({
        ...tree!,
        notes: tree!.notes.map((n) => ({ ...n, title: 'Renamed in sidebar' })),
      })),
    )
    await waitFor(() => expect(screen.getByLabelText('Note title')).toHaveValue('Renamed in sidebar'))
  })

  it('a title being edited is saved when the note is closed', async () => {
    const { requests, unmount } = setup()
    await findEditor()
    await userEvent.type(screen.getByLabelText('Note title'), ' 2')
    unmount()
    await waitFor(() => expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ title: 'My note 2' }))
  })
})

describe('image upload', () => {
  function setup(content: JSONContent = text('Body')) {
    const aids = [AID, AID2]
    const fetch = mockFetch({
      'GET /api/tree': treeWith(),
      [`GET /api/notes/${NOTE_ID}`]: { body: { note: fullNote(content) } },
      'POST /api/attachments': () => ({ status: 201, body: { id: aids.shift() } }),
      [`PUT /api/notes/${NOTE_ID}/content`]: { body: { version: 2 } },
    })
    return { ...fetch, ...renderPane() }
  }

  it('the toolbar button uploads to POST /api/attachments and inserts attachment://<aid>, displayed via the owner URL', async () => {
    const { requests } = setup()
    const editor = await findEditor()
    const user = userEvent.setup()
    await user.upload(screen.getByTestId('image-file-input'), png())

    await waitFor(() => expect(imageSrcs(editor.getJSON())).toEqual([`attachment://${AID}`]))
    const upload = requests.find((r) => r.path === '/api/attachments')!
    expect(upload.method).toBe('POST')
    expect(upload.body).toBeInstanceOf(FormData)
    expect((upload.body as FormData).get('file')).toBeInstanceOf(File)
    expect(editor.view.dom.querySelector('img')!.getAttribute('src')).toBe(`/api/attachments/${AID}`)

    // the saved content carries the reference, never the private route
    await waitFor(() => expect(requests.some((r) => r.method === 'PUT')).toBe(true), { timeout: 3000 })
    const saved = JSON.stringify(requests.find((r) => r.method === 'PUT')!.body)
    expect(saved).toContain(`attachment://${AID}`)
    expect(saved).not.toContain('/api/attachments')
  })

  it('pasting an image file uploads and inserts it', async () => {
    setup()
    const editor = await findEditor()
    act(() => void editor.view.dom.dispatchEvent(fileEvent('paste', [png()])))
    await waitFor(() => expect(imageSrcs(editor.getJSON())).toEqual([`attachment://${AID}`]))
  })

  it('dropping image files uploads them and inserts them at the drop point in order', async () => {
    setup(doc({ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'second' }] }))
    const editor = await findEditor()
    // jsdom has no layout: report the drop as landing between the two paragraphs
    const between = editor.state.doc.child(0).nodeSize
    editor.view.posAtCoords = () => ({ pos: between, inside: -1 })
    act(() => void editor.view.dom.dispatchEvent(fileEvent('drop', [png('a.png'), png('b.png')])))

    await waitFor(() => expect(imageSrcs(editor.getJSON())).toHaveLength(2))
    expect(editor.getJSON().content!.map((n) => n.type)).toEqual(['paragraph', 'image', 'image', 'paragraph'])
    expect(imageSrcs(editor.getJSON())).toEqual([`attachment://${AID}`, `attachment://${AID2}`])
  })

  it('rejects unsupported or oversized files before uploading', async () => {
    const { requests } = setup()
    const editor = await findEditor()
    const svg = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })
    const huge = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
    act(() => void editor.view.dom.dispatchEvent(fileEvent('paste', [svg, huge])))

    expect(await screen.findByText(/x\.svg is not a PNG, JPEG, WebP or GIF image/)).toBeInTheDocument()
    expect(await screen.findByText(/big\.png is larger than 10 MB/)).toBeInTheDocument()
    expect(requests.some((r) => r.path === '/api/attachments')).toBe(false)
    expect(imageSrcs(editor.getJSON())).toEqual([])
  })

  it('a failed upload shows an error and inserts nothing', async () => {
    mockFetch({
      'GET /api/tree': treeWith(),
      [`GET /api/notes/${NOTE_ID}`]: { body: { note: fullNote(text('Body')) } },
      'POST /api/attachments': {
        status: 415,
        body: { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Only PNG, JPEG, WebP and GIF images are allowed' } },
      },
    })
    renderPane()
    const editor = await findEditor()
    fireEvent.change(screen.getByTestId('image-file-input'), { target: { files: [png()] } })
    expect(await screen.findByText(/Could not upload cat\.png: Only PNG/)).toBeInTheDocument()
    expect(imageSrcs(editor.getJSON())).toEqual([])
  })
})
