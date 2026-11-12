import type { TreeData, TreeFolder, TreeNote } from './api'

interface TreeItemBase {
  id: string
  /** Display name (a note's trimmed title, or "Untitled"). */
  name: string
  /** Parent folder id as placed in the tree (null = root, also for orphans). */
  parentId: string | null
  /** 0 for top-level items. */
  depth: number
}

export interface FolderItem extends TreeItemBase {
  kind: 'folder'
  folder: TreeFolder
  children: TreeItem[]
}

export interface NoteItem extends TreeItemBase {
  kind: 'note'
  note: TreeNote
}

export type TreeItem = FolderItem | NoteItem

export const UNTITLED = 'Untitled'

export const displayTitle = (title: string): string => title.trim() || UNTITLED

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Folders first, then notes; each group by name (case-insensitive, numeric), then by id for stability. */
function compareItems(a: TreeItem, b: TreeItem): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
  return collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * Builds the nested, sorted tree from the flat `GET /api/tree` lists.
 *
 * Orphan-safe: an item whose parent folder is missing (e.g. a cache mid-update) is placed at the root.
 * Parent cycles cannot occur (the server rejects them and moves into a folder's own subtree are
 * never offered); each folder is still visited at most once, so a bad cache can never loop forever.
 */
export function buildTree(folders: TreeFolder[], notes: TreeNote[]): TreeItem[] {
  const folderIds = new Set(folders.map((f) => f.id))
  const childrenOf = new Map<string | null, TreeItem[]>()
  const push = (parent: string | null, item: TreeItem) => {
    const list = childrenOf.get(parent)
    if (list) list.push(item)
    else childrenOf.set(parent, [item])
  }

  const folderItems: FolderItem[] = folders.map((folder) => ({
    kind: 'folder',
    id: folder.id,
    name: folder.name,
    parentId: null,
    depth: 0,
    folder,
    children: [],
  }))
  for (const item of folderItems) {
    const parent = item.folder.parent_folder_id
    push(parent !== null && folderIds.has(parent) ? parent : null, item)
  }
  for (const note of notes) {
    const parent = note.folder_id !== null && folderIds.has(note.folder_id) ? note.folder_id : null
    push(parent, { kind: 'note', id: note.id, name: displayTitle(note.title), parentId: null, depth: 0, note })
  }

  const visited = new Set<string>()
  /** Sorts `items`, places them under `parentId` and recursively attaches each folder's children. */
  const attach = (candidates: TreeItem[], parentId: string | null, depth: number): TreeItem[] => {
    const items = candidates.filter((item) => !(item.kind === 'folder' && visited.has(item.id)))
    items.sort(compareItems)
    for (const item of items) {
      item.parentId = parentId
      item.depth = depth
      if (item.kind === 'folder') {
        visited.add(item.id)
        item.children = attach(childrenOf.get(item.id) ?? [], item.id, depth + 1)
      }
    }
    return items
  }

  return attach(childrenOf.get(null) ?? [], null, 0)
}

/**
 * Ids of folder `rootId` and every folder below it (by `parent_folder_id`). Cycle-safe: each folder
 * is visited once. Used to keep a folder out of its own subtree (Move-to, drop targets).
 */
export function subtreeFolderIds(folders: TreeFolder[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const f of folders) {
    if (f.parent_folder_id === null) continue
    const list = childrenOf.get(f.parent_folder_id)
    if (list) list.push(f.id)
    else childrenOf.set(f.parent_folder_id, [f.id])
  }
  const ids = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length > 0) {
    for (const child of childrenOf.get(stack.pop()!) ?? []) {
      if (!ids.has(child)) {
        ids.add(child)
        stack.push(child)
      }
    }
  }
  return ids
}

/** What deleting folder `folderId` removes besides the folder itself: its subfolders and notes at any depth. */
export function countFolderContents(tree: TreeData, folderId: string): { folders: number; notes: number } {
  const ids = subtreeFolderIds(tree.folders, folderId)
  return {
    folders: ids.size - 1,
    notes: tree.notes.filter((n) => n.folder_id !== null && ids.has(n.folder_id)).length,
  }
}
