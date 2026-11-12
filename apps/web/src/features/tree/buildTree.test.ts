import type { TreeFolder, TreeNote } from './api'
import { buildTree, displayTitle } from './buildTree'

const folder = (id: string, name: string, parent: string | null = null, created_at = 1): TreeFolder => ({
  id,
  name,
  parent_folder_id: parent,
  created_at,
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

/** Compact shape for assertions: `name` for notes, `[name, children]` for folders. */
type Shape = string | [string, Shape[]]
function shape(items: ReturnType<typeof buildTree>): Shape[] {
  return items.map((item) => (item.kind === 'folder' ? [item.name, shape(item.children)] : item.name))
}

describe('buildTree', () => {
  it('returns an empty list for an empty tree', () => {
    expect(buildTree([], [])).toEqual([])
  })

  it('converts flat lists into a nested tree', () => {
    const tree = buildTree(
      [folder('f1', 'Work'), folder('f2', 'Projects', 'f1'), folder('f3', 'Alpha', 'f2')],
      [note('n1', 'Plan', 'f3'), note('n2', 'Ideas', 'f1')],
    )
    expect(shape(tree)).toEqual([['Work', [['Projects', [['Alpha', ['Plan']]]], 'Ideas']]])
    const work = tree[0]
    expect(work?.depth).toBe(0)
    const projects = work?.kind === 'folder' ? work.children[0] : undefined
    expect(projects?.depth).toBe(1)
    expect(projects?.parentId).toBe('f1')
  })

  it('places root folders and root notes at the top level', () => {
    const tree = buildTree([folder('f1', 'Work')], [note('n1', 'Root note'), note('n2', 'Inside', 'f1')])
    expect(shape(tree)).toEqual([['Work', ['Inside']], 'Root note'])
    expect(tree.every((item) => item.depth === 0 && item.parentId === null)).toBe(true)
  })

  it('puts folders before notes, each sorted by name case-insensitively and numerically', () => {
    const tree = buildTree(
      [folder('f1', 'beta'), folder('f2', 'Alpha'), folder('f3', 'item 10'), folder('f4', 'item 2')],
      [note('n1', 'zeta'), note('n2', 'Apple'), note('n3', 'banana')],
    )
    expect(shape(tree)).toEqual([
      ['Alpha', []],
      ['beta', []],
      ['item 2', []],
      ['item 10', []],
      'Apple',
      'banana',
      'zeta',
    ])
  })

  it('sorts identical names stably by id', () => {
    const tree = buildTree([], [note('b', 'Same'), note('a', 'Same')])
    expect(tree.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('shows untitled notes as "Untitled" and sorts them by that name', () => {
    const tree = buildTree([], [note('n1', 'Zoo'), note('n2', '   '), note('n3', 'Apple')])
    expect(shape(tree)).toEqual(['Apple', 'Untitled', 'Zoo'])
  })

  it('is orphan-safe: items whose parent is missing go to the root', () => {
    const tree = buildTree(
      [folder('f1', 'Lost folder', 'missing-folder')],
      [note('n1', 'Lost note', 'missing-folder'), note('n2', 'Kept', 'f1')],
    )
    expect(shape(tree)).toEqual([['Lost folder', ['Kept']], 'Lost note'])
    expect(tree[0]?.parentId).toBeNull()
  })
})

describe('displayTitle', () => {
  it('trims and falls back to Untitled', () => {
    expect(displayTitle('  Hello ')).toBe('Hello')
    expect(displayTitle('')).toBe('Untitled')
  })
})
