import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockFetch, renderWithProviders, type MockResponse } from '@/test/utils'
import type { TreeData, TreeFolder, TreeNote } from './api'
import { Sidebar } from './Sidebar'
import { EXPANDED_STORAGE_KEY } from './useExpanded'

const folder = (id: string, name: string, parent: string | null = null): TreeFolder => ({
  id,
  name,
  parent_folder_id: parent,
  created_at: 1,
})

const note = (id: string, title: string, folderId: string | null = null): TreeNote => ({
  id,
  title,
  folder_id: folderId,
  version: 1,
  created_at: 1,
  updated_at: 1,
  share_type: 'private',
  expires_at: null,
})

const sampleTree: TreeData = {
  folders: [folder('f-work', 'Work'), folder('f-empty', 'Archive'), folder('f-sub', 'Projects', 'f-work')],
  notes: [note('n-root', 'Root note'), note('n-work', 'Meeting', 'f-work')],
}

function setup(tree: TreeData | MockResponse | (() => MockResponse | undefined), extra = {}, path = '/') {
  const treeRoute = typeof tree === 'function' || !('folders' in tree) ? tree : { body: tree }
  const mocks = mockFetch({ 'GET /api/tree': treeRoute, ...extra })
  const result = renderWithProviders(<Sidebar />, path)
  return { ...mocks, ...result, user: userEvent.setup() }
}

const treeItem = (name: string) => screen.getByRole('treeitem', { name })

describe('Sidebar loading and empty states', () => {
  it('shows a skeleton while the tree loads', async () => {
    let release: (res: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    )
    renderWithProviders(<Sidebar />)
    expect(screen.getByRole('status', { name: 'Loading folders and notes' })).toBeInTheDocument()
    expect(screen.queryByRole('tree')).not.toBeInTheDocument()

    release(new Response(JSON.stringify(sampleTree), { headers: { 'content-type': 'application/json' } }))
    expect(await screen.findByRole('tree')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Loading folders and notes' })).not.toBeInTheDocument()
  })

  it('shows a welcome state when there are no folders or notes', async () => {
    const { user, requests } = setup(
      { folders: [], notes: [] },
      { 'POST /api/notes': { status: 201, body: { note: { ...note('n-new', ''), content: { type: 'doc' } } } } },
    )
    expect(await screen.findByRole('heading', { name: 'Welcome to Notes' })).toBeInTheDocument()
    expect(screen.queryByRole('tree')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create your first note' }))
    expect(await screen.findByRole('treeitem', { name: 'Untitled' })).toBeInTheDocument()
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ folder_id: null })
    expect(screen.queryByRole('heading', { name: 'Welcome to Notes' })).not.toBeInTheDocument()
  })

  it('shows a hint inside an expanded empty folder', async () => {
    const { user } = setup(sampleTree)
    await user.click(within(await screen.findByRole('tree')).getByRole('button', { name: 'Archive' }))
    expect(within(treeItem('Archive')).getByText('Empty folder')).toBeInTheDocument()
    expect(within(treeItem('Work')).queryByText('Empty folder')).not.toBeInTheDocument()
  })

  it('shows an error with a retry button when the tree fails to load', async () => {
    let calls = 0
    const { user } = setup(() => {
      calls++
      return calls === 1
        ? { status: 400, body: { error: { code: 'BAD', message: 'Broken' } } }
        : { body: sampleTree }
    })
    expect(await screen.findByText('Could not load your notes.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('tree')).toBeInTheDocument()
  })
})

describe('Sidebar tree', () => {
  it('renders root items sorted, folders before notes, with children collapsed', async () => {
    setup(sampleTree)
    const tree = await screen.findByRole('tree')
    const topLevel = within(tree)
      .getAllByRole('treeitem')
      .filter((el) => el.getAttribute('aria-level') === '1')
    expect(topLevel.map((el) => el.getAttribute('aria-label'))).toEqual(['Archive', 'Work', 'Root note'])
    expect(treeItem('Work')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('treeitem', { name: 'Meeting' })).not.toBeInTheDocument()
  })

  it('expands and collapses folders and remembers the expanded state in localStorage', async () => {
    const { user, unmount } = setup(sampleTree)
    await user.click(within(await screen.findByRole('tree')).getByRole('button', { name: 'Work' }))
    expect(treeItem('Work')).toHaveAttribute('aria-expanded', 'true')
    expect(treeItem('Meeting')).toHaveAttribute('aria-level', '2')
    expect(treeItem('Projects')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(EXPANDED_STORAGE_KEY)!)).toEqual(['f-work'])

    unmount()
    setup(sampleTree)
    expect(await screen.findByRole('treeitem', { name: 'Meeting' })).toBeInTheDocument()
    expect(treeItem('Work')).toHaveAttribute('aria-expanded', 'true')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Work' }))
    expect(treeItem('Work')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('treeitem', { name: 'Meeting' })).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(EXPANDED_STORAGE_KEY)!)).toEqual([])
  })

  it('ignores corrupt expanded state in localStorage', async () => {
    localStorage.setItem(EXPANDED_STORAGE_KEY, '{not json')
    setup(sampleTree)
    expect(await screen.findByRole('tree')).toBeInTheDocument()
    expect(treeItem('Work')).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens a note by putting its id in the URL and marks it selected', async () => {
    const { user } = setup(sampleTree)
    await user.click(within(await screen.findByRole('tree')).getByRole('button', { name: 'Root note' }))
    expect(treeItem('Root note')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('search')).toHaveTextContent('?note=n-root')

    // selecting a folder afterwards moves the selection but keeps the open note
    await user.click(screen.getByRole('button', { name: 'Work' }))
    expect(treeItem('Work')).toHaveAttribute('aria-selected', 'true')
    expect(treeItem('Root note')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('search')).toHaveTextContent('?note=n-root')
  })
})

describe('Sidebar new note / new folder', () => {
  const created = {
    folder: folder('f-new', 'New folder', 'f-work'),
    rootFolder: folder('f-root-new', 'New folder'),
  }

  it('creates a note inside the selected folder and opens it', async () => {
    const { user, requests } = setup(sampleTree, {
      'POST /api/notes': { status: 201, body: { note: { ...note('n-new', '', 'f-work'), content: { type: 'doc' } } } },
    })
    await user.click(within(await screen.findByRole('tree')).getByRole('button', { name: 'Work' }))
    expect(screen.getByText('in Work')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New note' }))

    expect(await screen.findByRole('treeitem', { name: 'Untitled' })).toHaveAttribute('aria-level', '2')
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ folder_id: 'f-work' })
    // the tree cache updates (item appears) before the mutate-level onSuccess opens the note
    await waitFor(() => expect(treeItem('Untitled')).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByTestId('search')).toHaveTextContent('?note=n-new')
  })

  it('creates a folder inside the selected folder and expands the parent', async () => {
    const { user, requests } = setup(sampleTree, { 'POST /api/folders': { status: 201, body: { folder: created.folder } } })
    await user.click(within(await screen.findByRole('tree')).getByRole('button', { name: 'Work' }))
    // collapse it again: creating inside must re-expand the parent so the new folder is visible
    await user.click(screen.getByRole('button', { name: 'Work' }))
    await user.click(screen.getByRole('button', { name: 'New folder' }))

    expect(await screen.findByRole('treeitem', { name: 'New folder' })).toHaveAttribute('aria-level', '2')
    expect(treeItem('Work')).toHaveAttribute('aria-expanded', 'true')
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ name: 'New folder', parent_folder_id: 'f-work' })
    await waitFor(() => expect(treeItem('New folder')).toHaveAttribute('aria-selected', 'true'))
  })

  it('creates in the selected note’s folder when a note is selected', async () => {
    const { user, requests } = setup(
      sampleTree,
      { 'POST /api/folders': { status: 201, body: { folder: created.folder } } },
      '/?note=n-work',
    )
    expect(await screen.findByText('in Work')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    await waitFor(() => expect(requests.some((r) => r.method === 'POST')).toBe(true))
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ name: 'New folder', parent_folder_id: 'f-work' })
  })

  it('creates at the root with nothing selected', async () => {
    const { user, requests } = setup(sampleTree, {
      'POST /api/notes': { status: 201, body: { note: { ...note('n-new', ''), content: { type: 'doc' } } } },
    })
    await screen.findByRole('tree')
    expect(screen.getByText('at root')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New note' }))
    expect(await screen.findByRole('treeitem', { name: 'Untitled' })).toHaveAttribute('aria-level', '1')
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ folder_id: null })
  })

  it('always offers creating at the root, even with a folder selected', async () => {
    const { user, requests } = setup(sampleTree, {
      'POST /api/folders': { status: 201, body: { folder: created.rootFolder } },
      'POST /api/notes': { status: 201, body: { note: { ...note('n-new', ''), content: { type: 'doc' } } } },
    })
    await user.click(within(await screen.findByRole('tree')).getByRole('button', { name: 'Work' }))
    await user.click(screen.getByRole('button', { name: 'New folder at root' }))
    expect(await screen.findByRole('treeitem', { name: 'New folder' })).toHaveAttribute('aria-level', '1')
    await user.click(screen.getByRole('button', { name: 'New note at root' }))
    expect(await screen.findByRole('treeitem', { name: 'Untitled' })).toHaveAttribute('aria-level', '1')
    const posts = requests.filter((r) => r.method === 'POST').map((r) => r.body)
    expect(posts).toEqual([{ name: 'New folder', parent_folder_id: null }, { folder_id: null }])
  })

  it('shows an error toast when creating fails', async () => {
    const { user } = setup(sampleTree, {
      'POST /api/notes': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Folder not found' } } },
    })
    await screen.findByRole('tree')
    await user.click(screen.getByRole('button', { name: 'New note' }))
    expect(await screen.findByText('Could not create note: Folder not found')).toBeInTheDocument()
  })
})
