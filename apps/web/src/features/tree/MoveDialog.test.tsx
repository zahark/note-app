import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockFetch, renderWithProviders, type MockResponse, type RecordedRequest } from '@/test/utils'
import type { TreeData, TreeFolder, TreeNote } from './api'
import { buildTree, type TreeItem } from './buildTree'
import { moveDestinations } from './treeOps'
import { Sidebar } from './Sidebar'

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

// Work > Projects > Deep, plus Archive and a root note
const tree: TreeData = {
  folders: [
    folder('f-work', 'Work'),
    folder('f-sub', 'Projects', 'f-work'),
    folder('f-deep', 'Deep', 'f-sub'),
    folder('f-arch', 'Archive'),
  ],
  notes: [note('n-root', 'Root note'), note('n-deep', 'Deep note', 'f-deep')],
}

/** Finds an item anywhere in the built tree. */
function findItem(items: TreeItem[], id: string): TreeItem {
  for (const item of items) {
    if (item.id === id) return item
    if (item.kind === 'folder') {
      try {
        return findItem(item.children, id)
      } catch {
        // not below this folder
      }
    }
  }
  throw new Error(`no item ${id}`)
}

const itemOf = (id: string) => findItem(buildTree(tree.folders, tree.notes), id)

describe('moveDestinations', () => {
  it('excludes the folder itself and all its descendants', () => {
    const names = moveDestinations(tree, itemOf('f-work')).map((d) => d.name)
    expect(names).toEqual(['Root', 'Archive'])
  })

  it('excludes only the subtree of a nested folder, keeping its ancestors', () => {
    const dests = moveDestinations(tree, itemOf('f-sub'))
    expect(dests).toEqual([
      { id: null, name: 'Root', depth: 0 },
      { id: 'f-arch', name: 'Archive', depth: 1 },
      { id: 'f-work', name: 'Work', depth: 1 },
    ])
  })

  it('offers the root and every folder, in tree order with depth, for a note', () => {
    const dests = moveDestinations(tree, itemOf('n-deep'))
    expect(dests.map((d) => [d.name, d.depth])).toEqual([
      ['Root', 0],
      ['Archive', 1],
      ['Work', 1],
      ['Projects', 2],
      ['Deep', 3],
    ])
  })

  it('terminates on a folder cycle in a stale cache', () => {
    const cyclic: TreeData = { folders: [folder('a', 'A', 'b'), folder('b', 'B', 'a')], notes: [] }
    const item: TreeItem = { kind: 'folder', id: 'a', name: 'A', parentId: null, depth: 0, folder: cyclic.folders[0]!, children: [] }
    expect(moveDestinations(cyclic, item).map((d) => d.name)).toEqual(['Root'])
  })
})

/** A response the test releases by hand, to observe the optimistic state first. */
function deferred() {
  let release: (res: MockResponse) => void = () => {}
  const promise = new Promise<MockResponse>((resolve) => (release = resolve))
  return { promise, release }
}

function setup(
  extra: Record<string, MockResponse | ((req: RecordedRequest) => Promise<MockResponse>)> = {},
  data: TreeData = tree,
) {
  let treeCalls = 0
  const mocks = mockFetch({
    // later refetches never answer, so only the rollback itself can restore the tree
    'GET /api/tree': () => (treeCalls++ === 0 ? { body: data } : new Promise<MockResponse>(() => {})),
    ...extra,
  })
  renderWithProviders(<Sidebar />)
  return { ...mocks, user: userEvent.setup() }
}

const treeItem = (name: string) => screen.getByRole('treeitem', { name })

async function openMoveDialog(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(await screen.findByRole('tree')).getByRole('button', { name: `Actions for ${name}` }))
  await user.click(await screen.findByRole('menuitem', { name: 'Move to…' }))
  return screen.findByRole('dialog', { name: `Move “${name}”` })
}

describe('MoveDialog', () => {
  it('lists the root and other folders but not the moved folder or its descendants', async () => {
    const { user } = setup()
    const dialog = await openMoveDialog(user, 'Work')
    const options = within(dialog).getAllByRole('radio')
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual(['Root (current)', 'Archive'])
    expect(within(dialog).queryByRole('radio', { name: /Projects|Deep|Work/ })).not.toBeInTheDocument()
  })

  it('treats an orphan (its folder is gone) as being at the root, like drag and drop does', async () => {
    const { user } = setup({}, { folders: tree.folders, notes: [note('n-orphan', 'Orphan', 'f-gone')] })
    const dialog = await openMoveDialog(user, 'Orphan')
    expect(within(dialog).getByRole('radio', { name: 'Root (current)' })).toBeDisabled()
    expect(within(dialog).getByRole('radio', { name: 'Archive' })).toBeEnabled()
  })

  it('disables the current location and the Move button until another destination is chosen', async () => {
    localStorage.setItem('notes-app:tree-expanded', JSON.stringify(['f-work', 'f-sub', 'f-deep']))
    const { user, requests } = setup()
    const dialog = await openMoveDialog(user, 'Deep note')
    expect(within(dialog).getByRole('radio', { name: 'Deep (current)' })).toBeDisabled()
    const moveButton = within(dialog).getByRole('button', { name: 'Move' })
    expect(moveButton).toBeDisabled()

    await user.click(within(dialog).getByRole('radio', { name: 'Archive' }))
    expect(moveButton).toBeEnabled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(requests.filter((r) => r.method === 'PATCH')).toEqual([])
  })

  it('moves a folder optimistically and keeps the server’s result', async () => {
    const response = deferred()
    const { user, requests } = setup({ 'PATCH /api/folders/f-work/move': () => response.promise })
    const dialog = await openMoveDialog(user, 'Work')
    await user.click(within(dialog).getByRole('radio', { name: 'Archive' }))
    await user.click(within(dialog).getByRole('button', { name: 'Move' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // moved before the server answered, with the target expanded so it stays visible
    expect(treeItem('Archive')).toHaveAttribute('aria-expanded', 'true')
    expect(treeItem('Work')).toHaveAttribute('aria-level', '2')
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ parent_folder_id: 'f-arch' })

    response.release({ body: { folder: folder('f-work', 'Work', 'f-arch') } })
    await waitFor(() => expect(requests.filter((r) => r.method === 'GET')).toHaveLength(1))
    expect(treeItem('Work')).toHaveAttribute('aria-level', '2')
  })

  it('moves a note to the root', async () => {
    localStorage.setItem('notes-app:tree-expanded', JSON.stringify(['f-work', 'f-sub', 'f-deep']))
    const { user, requests } = setup({
      'PATCH /api/notes/n-deep/move': { body: { note: note('n-deep', 'Deep note') } },
    })
    const dialog = await openMoveDialog(user, 'Deep note')
    await user.click(within(dialog).getByRole('radio', { name: 'Root' }))
    await user.click(within(dialog).getByRole('button', { name: 'Move' }))

    await waitFor(() => expect(treeItem('Deep note')).toHaveAttribute('aria-level', '1'))
    expect(requests.find((r) => r.method === 'PATCH')).toMatchObject({
      path: '/api/notes/n-deep/move',
      body: { folder_id: null },
    })
    expect(within(treeItem('Deep')).getByText('Empty folder')).toBeInTheDocument()
  })

  it('rolls the move back and shows a toast when the server refuses it', async () => {
    const response = deferred()
    const { user } = setup({ 'PATCH /api/folders/f-work/move': () => response.promise })
    const dialog = await openMoveDialog(user, 'Work')
    await user.click(within(dialog).getByRole('radio', { name: 'Archive' }))
    await user.click(within(dialog).getByRole('button', { name: 'Move' }))
    expect(treeItem('Work')).toHaveAttribute('aria-level', '2')

    response.release({ status: 409, body: { error: { code: 'FOLDER_CYCLE', message: 'Cannot move a folder into itself' } } })
    expect(await screen.findByText('Could not move folder: Cannot move a folder into itself')).toBeInTheDocument()
    expect(treeItem('Work')).toHaveAttribute('aria-level', '1')
  })
})
