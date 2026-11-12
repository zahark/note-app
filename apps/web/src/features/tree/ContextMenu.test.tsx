import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockFetch, renderWithProviders, type MockResponse, type RecordedRequest } from '@/test/utils'
import type { TreeData, TreeFolder, TreeNote } from './api'
import { countFolderContents, subtreeFolderIds, type FolderItem } from './buildTree'
import { removeFolderFromTree } from './mutations'
import { deleteDescription } from './treeOps'
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

// Work > (Projects > Deep), with notes at several depths; Archive is empty
const tree: TreeData = {
  folders: [
    folder('f-work', 'Work'),
    folder('f-sub', 'Projects', 'f-work'),
    folder('f-deep', 'Deep', 'f-sub'),
    folder('f-arch', 'Archive'),
  ],
  notes: [
    note('n-root', 'Root note'),
    note('n-work', 'Meeting', 'f-work'),
    note('n-sub', 'Plan', 'f-sub'),
    note('n-deep', 'Detail', 'f-deep'),
  ],
}

describe('tree helpers', () => {
  it('collects a folder subtree at any depth, cycle-safe', () => {
    expect([...subtreeFolderIds(tree.folders, 'f-work')].sort()).toEqual(['f-deep', 'f-sub', 'f-work'])
    expect([...subtreeFolderIds(tree.folders, 'f-arch')]).toEqual(['f-arch'])
    const cyclic = [folder('a', 'A', 'b'), folder('b', 'B', 'a')]
    expect([...subtreeFolderIds(cyclic, 'a')].sort()).toEqual(['a', 'b'])
  })

  it('counts what a folder delete cascades to', () => {
    expect(countFolderContents(tree, 'f-work')).toEqual({ folders: 2, notes: 3 })
    expect(countFolderContents(tree, 'f-deep')).toEqual({ folders: 0, notes: 1 })
    expect(countFolderContents(tree, 'f-arch')).toEqual({ folders: 0, notes: 0 })
  })

  it('removes a folder with its whole subtree from the cached tree', () => {
    expect(removeFolderFromTree(tree, 'f-sub')).toEqual({
      folders: [tree.folders[0], tree.folders[3]],
      notes: [tree.notes[0], tree.notes[1]],
    })
  })

  it('describes the cascade in the delete confirmation', () => {
    const item = (id: string): FolderItem => {
      const f = tree.folders.find((x) => x.id === id)!
      return { kind: 'folder', id, name: f.name, parentId: null, depth: 0, folder: f, children: [] }
    }
    expect(deleteDescription(tree, item('f-work'))).toBe(
      'This folder and everything in it will be permanently deleted: 2 subfolders and 3 notes.',
    )
    expect(deleteDescription(tree, item('f-deep'))).toBe('This folder and everything in it will be permanently deleted: 1 note.')
    expect(deleteDescription(tree, item('f-arch'))).toBe('This empty folder will be permanently deleted.')
  })
})

/** A response the test releases by hand, to observe the optimistic state first. */
function deferred() {
  let release: (res: MockResponse) => void = () => {}
  const promise = new Promise<MockResponse>((resolve) => (release = resolve))
  return { promise, release }
}

type Route = MockResponse | ((req: RecordedRequest) => MockResponse | Promise<MockResponse>)

function setup(extra: Record<string, Route> = {}, path = '/') {
  let treeCalls = 0
  const mocks = mockFetch({
    // later refetches never answer, so only the rollback itself can restore the tree
    'GET /api/tree': () => (treeCalls++ === 0 ? { body: tree } : new Promise<MockResponse>(() => {})),
    ...extra,
  })
  renderWithProviders(<Sidebar />, path)
  return { ...mocks, user: userEvent.setup() }
}

const treeItem = (name: string) => screen.getByRole('treeitem', { name })
const mutations = (requests: RecordedRequest[]) => requests.filter((r) => r.method !== 'GET')

describe('row menus', () => {
  it('opens the actions on right-click and runs the chosen one', async () => {
    const { user } = setup()
    fireEvent.contextMenu(within(await screen.findByRole('tree')).getByRole('button', { name: 'Work' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Rename', 'Move to…', 'Delete'])

    await user.click(within(menu).getByRole('menuitem', { name: 'Rename' }))
    expect(await screen.findByRole('textbox', { name: 'Rename folder' })).toHaveFocus()
  })

  it('opens the same actions from the "…" button', async () => {
    const { user } = setup()
    await user.click(within(await screen.findByRole('tree')).getByRole('button', { name: 'Actions for Root note' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Rename', 'Move to…', 'Delete'])
  })
})

async function startRename(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(await screen.findByRole('tree')).getByRole('button', { name: `Actions for ${name}` }))
  await user.click(await screen.findByRole('menuitem', { name: 'Rename' }))
  return screen.findByRole('textbox', { name: /^Rename/ })
}

describe('inline rename', () => {
  it('renames a folder on Enter, optimistically, keeping the focus in the field until then', async () => {
    const response = deferred()
    const { user, requests } = setup({ 'PATCH /api/folders/f-work': () => response.promise })
    const input = await startRename(user, 'Work')
    expect(input).toHaveFocus()
    expect(input).toHaveValue('Work')

    await user.clear(input)
    await user.type(input, '  Office  {Enter}')
    // trimmed name shown before the server answers
    expect(treeItem('Office')).toBeInTheDocument()
    expect(mutations(requests)).toMatchObject([{ method: 'PATCH', path: '/api/folders/f-work', body: { name: 'Office' } }])

    response.release({ body: { folder: folder('f-work', 'Office') } })
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
    expect(treeItem('Office')).toBeInTheDocument()
  })

  it('renames a note with F2 and saves its title as typed through the metadata endpoint', async () => {
    const { user, requests } = setup({ 'PATCH /api/notes/n-root': { body: { note: note('n-root', ' Ideas ') } } })
    const row = within(await screen.findByRole('tree')).getByRole('button', { name: 'Root note' })
    row.focus()
    await user.keyboard('{F2}')
    const input = screen.getByRole('textbox', { name: 'Rename note' })
    await user.clear(input)
    await user.type(input, ' Ideas ')
    // leaving the field saves too
    await user.click(screen.getByRole('button', { name: 'Archive' }))

    expect(await screen.findByRole('treeitem', { name: 'Ideas' })).toBeInTheDocument()
    expect(mutations(requests)).toEqual([
      expect.objectContaining({ method: 'PATCH', path: '/api/notes/n-root', body: { title: ' Ideas ' } }),
    ])
  })

  it('cancels on Escape and sends nothing when the name is unchanged or a folder name is blank', async () => {
    const { user, requests } = setup()
    let input = await startRename(user, 'Work')
    await user.type(input, 'X{Escape}')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(treeItem('Work')).toBeInTheDocument()

    await startRename(user, 'Work')
    await user.keyboard('{Enter}')
    input = await startRename(user, 'Work')
    await user.clear(input)
    await user.type(input, '   {Enter}')
    expect(treeItem('Work')).toBeInTheDocument()
    expect(mutations(requests)).toEqual([])
  })

  it('rolls the rename back and shows a toast when the server refuses it', async () => {
    const response = deferred()
    const { user } = setup({ 'PATCH /api/folders/f-work': () => response.promise })
    const input = await startRename(user, 'Work')
    await user.clear(input)
    await user.type(input, 'Office{Enter}')
    expect(treeItem('Office')).toBeInTheDocument()

    response.release({ status: 500, body: { error: { code: 'INTERNAL', message: 'Server exploded' } } })
    expect(await screen.findByText('Could not rename folder: Server exploded')).toBeInTheDocument()
    expect(treeItem('Work')).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: 'Office' })).not.toBeInTheDocument()
  })

  it('refetches the tree after a refused change and shows the server’s copy', async () => {
    const response = deferred()
    let treeCalls = 0
    const { user, requests } = setup({
      // the second load (the refetch after the failure) has a change made elsewhere meanwhile
      'GET /api/tree': () =>
        treeCalls++ === 0
          ? { body: tree }
          : { body: { ...tree, folders: tree.folders.map((f) => (f.id === 'f-arch' ? { ...f, name: 'Old stuff' } : f)) } },
      'PATCH /api/folders/f-work': () => response.promise,
    })
    const input = await startRename(user, 'Work')
    await user.clear(input)
    await user.type(input, 'Office{Enter}')
    expect(requests.filter((r) => r.path === '/api/tree')).toHaveLength(1)

    response.release({ status: 500, body: { error: { code: 'INTERNAL', message: 'Server exploded' } } })
    expect(await screen.findByRole('treeitem', { name: 'Old stuff' })).toBeInTheDocument()
    expect(requests.filter((r) => r.path === '/api/tree')).toHaveLength(2)
    expect(treeItem('Work')).toBeInTheDocument()
  })

  it('puts a newly created folder straight into rename mode', async () => {
    const { user, requests } = setup({
      'POST /api/folders': { status: 201, body: { folder: folder('f-new', 'New folder') } },
      'PATCH /api/folders/f-new': { body: { folder: folder('f-new', 'Recipes') } },
    })
    await screen.findByRole('tree')
    await user.click(screen.getByRole('button', { name: 'New folder at root' }))
    const input = await screen.findByRole('textbox', { name: 'Rename folder' })
    expect(input).toHaveFocus()
    // the default name is selected, so typing replaces it
    await user.keyboard('Recipes{Enter}')
    expect(await screen.findByRole('treeitem', { name: 'Recipes' })).toBeInTheDocument()
    expect(mutations(requests).map((r) => r.body)).toEqual([
      { name: 'New folder', parent_folder_id: null },
      { name: 'Recipes' },
    ])
  })
})

async function openDelete(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(await screen.findByRole('tree')).getByRole('button', { name: `Actions for ${name}` }))
  await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
  return screen.findByRole('dialog')
}

describe('delete with confirm', () => {
  it('states the cascade count for a folder and deletes it with its contents on confirm', async () => {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(['f-work']))
    const { user, requests } = setup({ 'DELETE /api/folders/f-work': { status: 204 } })
    const dialog = await openDelete(user, 'Work')
    expect(within(dialog).getByRole('heading', { name: 'Delete folder “Work”?' })).toBeInTheDocument()
    expect(dialog).toHaveTextContent('This folder and everything in it will be permanently deleted: 2 subfolders and 3 notes.')

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: 'Work' })).not.toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: 'Meeting' })).not.toBeInTheDocument()
    expect(treeItem('Archive')).toBeInTheDocument()
    await waitFor(() => expect(mutations(requests)).toMatchObject([{ method: 'DELETE', path: '/api/folders/f-work' }]))
  })

  it('does nothing when the confirmation is cancelled', async () => {
    const { user, requests } = setup()
    const dialog = await openDelete(user, 'Root note')
    expect(within(dialog).getByRole('heading', { name: 'Delete note “Root note”?' })).toBeInTheDocument()
    expect(dialog).toHaveTextContent('This note will be permanently deleted.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(treeItem('Root note')).toBeInTheDocument()
    expect(mutations(requests)).toEqual([])
  })

  it('closes the open note when it is deleted', async () => {
    const { user } = setup({ 'DELETE /api/notes/n-root': { status: 204 } }, '/?note=n-root')
    await user.click(within(await openDelete(user, 'Root note')).getByRole('button', { name: 'Delete' }))
    expect(screen.getByTestId('search')).toBeEmptyDOMElement()
  })

  it('closes the open note when a folder above it is deleted', async () => {
    const { user } = setup({ 'DELETE /api/folders/f-work': { status: 204 } }, '/?note=n-deep')
    await user.click(within(await openDelete(user, 'Work')).getByRole('button', { name: 'Delete' }))
    expect(screen.getByTestId('search')).toBeEmptyDOMElement()
  })

  it('rolls the delete back and shows a toast when the server refuses it', async () => {
    const response = deferred()
    const { user } = setup({ 'DELETE /api/folders/f-work': () => response.promise })
    await user.click(within(await openDelete(user, 'Work')).getByRole('button', { name: 'Delete' }))
    expect(screen.queryByRole('treeitem', { name: 'Work' })).not.toBeInTheDocument()

    response.release({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Folder not found' } } })
    expect(await screen.findByText('Could not delete folder: Folder not found')).toBeInTheDocument()
    expect(treeItem('Work')).toBeInTheDocument()
  })
})
