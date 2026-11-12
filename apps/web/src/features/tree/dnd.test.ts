import { createElement } from 'react'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockFetch, renderWithProviders, type MockResponse, type RecordedRequest } from '@/test/utils'
import type { TreeData, TreeFolder, TreeNote } from './api'
import { buildTree, type TreeItem } from './buildTree'
import { dropRules } from './treeOps'
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

// Work > Projects > Deep, plus an empty Archive, a root note and a note in Deep
const tree: TreeData = {
  folders: [
    folder('f-work', 'Work'),
    folder('f-sub', 'Projects', 'f-work'),
    folder('f-deep', 'Deep', 'f-sub'),
    folder('f-arch', 'Archive'),
  ],
  notes: [note('n-root', 'Root note'), note('n-deep', 'Deep note', 'f-deep')],
}

function findItem(items: TreeItem[], id: string): TreeItem | undefined {
  for (const item of items) {
    if (item.id === id) return item
    const found = item.kind === 'folder' ? findItem(item.children, id) : undefined
    if (found) return found
  }
  return undefined
}

const itemOf = (id: string) => findItem(buildTree(tree.folders, tree.notes), id)!

describe('dropRules', () => {
  it('makes the dragged folder and all its descendants invalid drop targets', () => {
    const statusOf = dropRules(tree, itemOf('f-work'))
    expect(statusOf('f-work')).toBe('invalid')
    expect(statusOf('f-sub')).toBe('invalid')
    expect(statusOf('f-deep')).toBe('invalid')
    expect(statusOf('f-arch')).toBe('valid')
  })

  it('accepts the root for a nested folder, and its ancestors other than its own parent', () => {
    const statusOf = dropRules(tree, itemOf('f-sub'))
    expect(statusOf(null)).toBe('valid')
    expect(statusOf('f-work')).toBe('current')
    expect(statusOf('f-arch')).toBe('valid')
    expect(statusOf('f-sub')).toBe('invalid')
    expect(statusOf('f-deep')).toBe('invalid')
  })

  it('treats the current location as a no-op: the root for top-level items, the folder for a note', () => {
    expect(dropRules(tree, itemOf('f-work'))(null)).toBe('current')
    expect(dropRules(tree, itemOf('n-root'))(null)).toBe('current')
    const statusOf = dropRules(tree, itemOf('n-deep'))
    expect(statusOf('f-deep')).toBe('current')
    expect(statusOf(null)).toBe('valid')
    expect(['f-work', 'f-sub', 'f-arch'].map(statusOf)).toEqual(['valid', 'valid', 'valid'])
  })

  it('rejects a folder that is not in the tree', () => {
    expect(dropRules(tree, itemOf('n-root'))('f-gone')).toBe('invalid')
  })

  it('terminates on a folder cycle in a stale cache', () => {
    const cyclic: TreeData = { folders: [folder('a', 'A', 'b'), folder('b', 'B', 'a'), folder('c', 'C')], notes: [] }
    const item: TreeItem = { kind: 'folder', id: 'a', name: 'A', parentId: null, depth: 0, folder: cyclic.folders[0]!, children: [] }
    const statusOf = dropRules(cyclic, item)
    expect([statusOf('a'), statusOf('b'), statusOf('c')]).toEqual(['invalid', 'invalid', 'valid'])
  })
})

const ROW_HEIGHT = 28

/**
 * jsdom has no layout: give every row (and the root drop zone) a 28 px box, stacked in document
 * order, so dnd-kit can measure drop targets and hit-test the pointer. Anything inside a row
 * (the dragged button) gets that row's box, and the drag overlay starts over the dragged row,
 * as it does in a browser.
 */
function stubLayout() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const overlay = this.matches('[data-drag-overlay]') || this.querySelector(':scope > [data-drag-overlay]')
    const row = (overlay ? document.querySelector('[aria-pressed="true"]') : this)?.closest('[data-tree-row]')
    const index = row ? [...document.querySelectorAll('[data-tree-row]')].indexOf(row) : -1
    return index < 0 ? new DOMRect(0, 0, 0, 0) : new DOMRect(0, index * ROW_HEIGHT, 200, ROW_HEIGHT)
  })
}

function deferred() {
  let release: (res: MockResponse) => void = () => {}
  const promise = new Promise<MockResponse>((resolve) => (release = resolve))
  return { promise, release }
}

function setup(extra: Record<string, MockResponse | ((req: RecordedRequest) => Promise<MockResponse>)> = {}) {
  localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(['f-work', 'f-sub', 'f-deep']))
  stubLayout()
  let treeCalls = 0
  const mocks = mockFetch({
    // later refetches never answer, so only the rollback itself can restore the tree
    'GET /api/tree': () => (treeCalls++ === 0 ? { body: tree } : new Promise<MockResponse>(() => {})),
    ...extra,
  })
  renderWithProviders(createElement(Sidebar))
  return mocks
}

const treeItem = (name: string) => screen.getByRole('treeitem', { name })
const rowOf = (name: string) => treeItem(name).querySelector<HTMLElement>('[data-tree-row]')!
const rowButton = (name: string) => within(rowOf(name)).getByRole('button', { name })
const rootZone = () => screen.getByText(/Drop here to move to the root|Already at the root/).closest<HTMLElement>('[data-tree-row]')!
const moves = (requests: RecordedRequest[]) => requests.filter((r) => r.method === 'PATCH')

const centerOf = (el: Element) => {
  const rect = el.getBoundingClientRect()
  return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
}

/** Presses the mouse on `name`'s row and moves it past the 5 px threshold, starting a drag. */
function pickUp(name: string) {
  const start = centerOf(rowButton(name))
  fireEvent.mouseDown(rowButton(name), { button: 0, ...start })
  fireEvent.mouseMove(document, { ...start, clientY: start.clientY + 10 })
}

/** Moves the dragged row over `target` and releases it there. */
function dropOn(target: Element) {
  const point = centerOf(target)
  fireEvent.mouseMove(document, point)
  fireEvent.mouseUp(document, point)
}

describe('drag and drop with the mouse', () => {
  it('marks the dragged folder and its descendants as invalid targets and ignores a drop on them', async () => {
    const { requests } = setup()
    await screen.findByRole('tree')
    pickUp('Work')

    expect(rowOf('Work')).toHaveAttribute('data-drop-target', 'invalid')
    expect(rowOf('Projects')).toHaveAttribute('data-drop-target', 'invalid')
    expect(rowOf('Deep')).toHaveAttribute('data-drop-target', 'invalid')
    expect(rowOf('Archive')).toHaveAttribute('data-drop-target', 'valid')
    // Work already is at the root
    expect(rootZone()).toHaveTextContent('Already at the root')

    dropOn(rowOf('Deep'))
    expect(screen.queryByText('Already at the root')).not.toBeInTheDocument()
    expect(treeItem('Work')).toHaveAttribute('aria-level', '1')
    expect(rowOf('Deep')).not.toHaveAttribute('data-drop-target')
    expect(moves(requests)).toEqual([])
  })

  it('highlights the folder under the pointer and moves a folder into it', async () => {
    const { requests } = setup({ 'PATCH /api/folders/f-sub/move': { body: { folder: folder('f-sub', 'Projects', 'f-arch') } } })
    await screen.findByRole('tree')
    pickUp('Projects')
    fireEvent.mouseMove(document, centerOf(rowOf('Archive')))
    expect(rowOf('Archive')).toHaveAttribute('data-drop-target', 'over')
    fireEvent.mouseUp(document, centerOf(rowOf('Archive')))

    // the target is expanded so the moved folder stays in view
    expect(treeItem('Archive')).toHaveAttribute('aria-expanded', 'true')
    expect(await within(treeItem('Archive')).findByRole('treeitem', { name: 'Projects' })).toHaveAttribute('aria-level', '2')
    expect(moves(requests)).toMatchObject([{ path: '/api/folders/f-sub/move', body: { parent_folder_id: 'f-arch' } }])
  })

  it('accepts a drop on the root zone', async () => {
    const { requests } = setup({ 'PATCH /api/notes/n-deep/move': { body: { note: note('n-deep', 'Deep note') } } })
    await screen.findByRole('tree')
    pickUp('Deep note')
    expect(rootZone()).toHaveTextContent('Drop here to move to the root')
    expect(rowOf('Deep')).not.toHaveAttribute('data-drop-target')

    dropOn(rootZone())
    await waitFor(() => expect(treeItem('Deep note')).toHaveAttribute('aria-level', '1'))
    expect(moves(requests)).toMatchObject([{ path: '/api/notes/n-deep/move', body: { folder_id: null } }])
    expect(within(treeItem('Deep')).getByText('Empty folder')).toBeInTheDocument()
  })

  it('rolls the move back and shows a toast when the server answers 409', async () => {
    const response = deferred()
    setup({ 'PATCH /api/folders/f-sub/move': () => response.promise })
    await screen.findByRole('tree')
    pickUp('Projects')
    dropOn(rowOf('Archive'))
    // moved before the server answers
    expect(await within(treeItem('Archive')).findByRole('treeitem', { name: 'Projects' })).toBeInTheDocument()

    response.release({
      status: 409,
      body: { error: { code: 'FOLDER_CYCLE', message: 'A folder cannot be moved into itself or one of its subfolders' } },
    })
    expect(
      await screen.findByText('Could not move folder: A folder cannot be moved into itself or one of its subfolders'),
    ).toBeInTheDocument()
    expect(within(treeItem('Work')).getByRole('treeitem', { name: 'Projects' })).toHaveAttribute('aria-level', '2')
    expect(within(treeItem('Archive')).queryByRole('treeitem', { name: 'Projects' })).not.toBeInTheDocument()
  })

  it('still opens a note on a plain click', async () => {
    const { requests } = setup()
    await screen.findByRole('tree')
    const button = rowButton('Root note')
    fireEvent.mouseDown(button, { button: 0, ...centerOf(button) })
    fireEvent.mouseUp(document, centerOf(button))
    fireEvent.click(button)
    expect(screen.getByTestId('search')).toHaveTextContent('?note=n-root')
    expect(moves(requests)).toEqual([])
  })
})

/** Lets the keyboard sensor attach its listeners (it does so on the next tick). */
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

describe('drag and drop with the keyboard', () => {
  it('picks up with Space, moves between valid targets with the arrows and drops with Space', async () => {
    const { requests } = setup({ 'PATCH /api/notes/n-root/move': { body: { note: note('n-root', 'Root note', 'f-sub') } } })
    await screen.findByRole('tree')
    const button = rowButton('Root note')
    button.focus()
    fireEvent.keyDown(button, { key: ' ', code: 'Space' })
    await tick()

    // Root note is the last row: up goes to Deep, then Projects
    fireEvent.keyDown(button, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(rowOf('Deep')).toHaveAttribute('data-drop-target', 'over')
    fireEvent.keyDown(button, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(rowOf('Projects')).toHaveAttribute('data-drop-target', 'over')
    fireEvent.keyDown(button, { key: ' ', code: 'Space' })
    fireEvent.keyUp(button, { key: ' ', code: 'Space' })

    await waitFor(() => expect(moves(requests)).toMatchObject([{ path: '/api/notes/n-root/move', body: { folder_id: 'f-sub' } }]))
    expect(within(treeItem('Projects')).getByRole('treeitem', { name: 'Root note' })).toBeInTheDocument()
    // Space never opened the note
    expect(screen.getByTestId('search')).toBeEmptyDOMElement()
  })

  it('cancels with Escape and keeps Enter for opening the row', async () => {
    const { requests } = setup()
    await screen.findByRole('tree')
    const button = rowButton('Root note')
    button.focus()
    fireEvent.keyDown(button, { key: ' ', code: 'Space' })
    await tick()
    fireEvent.keyDown(button, { key: 'ArrowUp', code: 'ArrowUp' })
    fireEvent.keyDown(button, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(rowOf('Deep')).not.toHaveAttribute('data-drop-target'))
    expect(moves(requests)).toEqual([])

    // Enter is not a drag key: it opens the note as before
    await userEvent.setup().keyboard('{Enter}')
    expect(screen.getByTestId('search')).toHaveTextContent('?note=n-root')
    expect(rowOf('Deep')).not.toHaveAttribute('data-drop-target')
    expect(moves(requests)).toEqual([])
  })
})
