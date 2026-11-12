import { buildTree, countFolderContents, subtreeFolderIds, type TreeData, type TreeItem } from './buildTree'

export interface MoveDestination {
  /** Target folder id; null = root. */
  id: string | null
  name: string
  depth: number
}

/**
 * Where `item` can be moved: the root, then every folder in tree order. A folder can never go into
 * itself or anything below it (the server would reject the cycle with 409), so those are left out.
 */
export function moveDestinations(tree: TreeData, item: TreeItem): MoveDestination[] {
  const excluded = item.kind === 'folder' ? subtreeFolderIds(tree.folders, item.id) : new Set<string>()
  const destinations: MoveDestination[] = [{ id: null, name: 'Root', depth: 0 }]
  const walk = (items: TreeItem[], depth: number) => {
    for (const child of items) {
      if (child.kind !== 'folder' || excluded.has(child.id)) continue
      destinations.push({ id: child.id, name: child.name, depth })
      walk(child.children, depth + 1)
    }
  }
  walk(buildTree(tree.folders, []), 1)
  return destinations
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The confirmation text, spelling out what a folder delete cascades to. */
export function deleteDescription(tree: TreeData, item: TreeItem): string {
  if (item.kind === 'note') return 'This note will be permanently deleted.'
  const { folders, notes } = countFolderContents(tree, item.id)
  if (folders === 0 && notes === 0) return 'This empty folder will be permanently deleted.'
  const parts = [folders > 0 && plural(folders, 'subfolder'), notes > 0 && plural(notes, 'note')].filter(Boolean)
  return `This folder and everything in it will be permanently deleted: ${parts.join(' and ')}.`
}

/**
 * Whether the dragged item may be dropped into a folder (or the root, `null`):
 * - `valid`: a real move;
 * - `current`: where the item already is, so dropping there changes nothing;
 * - `invalid`: the dragged folder itself or any folder below it (the server would refuse the cycle
 *   with 409), or a folder that no longer exists.
 */
export type DropStatus = 'valid' | 'current' | 'invalid'

/**
 * The drop rules for one drag: returns the status of each possible target for `item`. The dragged
 * folder's subtree is computed once here, not once per row.
 */
export function dropRules(tree: TreeData, item: TreeItem): (target: string | null) => DropStatus {
  const excluded = item.kind === 'folder' ? subtreeFolderIds(tree.folders, item.id) : new Set<string>()
  const folderIds = new Set(tree.folders.map((f) => f.id))
  return (target) => {
    if (target !== null && (excluded.has(target) || !folderIds.has(target))) return 'invalid'
    // where the item is shown in the tree (an orphan is shown at the root)
    if (target === item.parentId) return 'current'
    return 'valid'
  }
}
