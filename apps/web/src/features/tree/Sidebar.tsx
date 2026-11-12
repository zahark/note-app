import { useMemo, useState } from 'react'
import { FilePlusIcon, FolderPlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useCreateFolder, useCreateNote, useTree } from './api'
import { buildTree, subtreeFolderIds, type TreeItem } from './buildTree'
import { DeleteDialog } from './DeleteDialog'
import { RootDropZone, TreeDnd } from './dnd'
import { MoveDialog } from './MoveDialog'
import { useDeleteFolder, useDeleteNote, useMoveFolder, useMoveNote, useRenameFolder, useRenameNote } from './mutations'
import { TreeNode, type TreeHandlers } from './TreeNode'
import { useExpanded } from './useExpanded'
import { useOpenNote } from './useOpenNote'

/**
 * Sidebar: header with "New note" / "New folder" (created inside the selected folder, or the
 * selected note's folder), the collapsible folder tree, and persistent "new at root" buttons.
 * Each row has a right-click / "…" menu with inline rename, Move to… and delete (with confirm);
 * those changes are applied optimistically and rolled back if the server refuses them. Rows can
 * also be dragged onto a folder or the root zone (mouse or keyboard), which moves them the same way.
 */
export function Sidebar() {
  const tree = useTree()
  const createFolder = useCreateFolder()
  const createNote = useCreateNote()
  const { expanded, toggle, expand } = useExpanded()
  const { noteId: openNoteId, openNote: showNote, closeNote } = useOpenNote()
  // a clicked folder takes the selection; otherwise the open note is the selection
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [moving, setMoving] = useState<TreeItem | null>(null)
  const [deleting, setDeleting] = useState<TreeItem | null>(null)
  const renameFolder = useRenameFolder()
  const renameNote = useRenameNote()
  const moveFolder = useMoveFolder()
  const moveNote = useMoveNote()
  const deleteFolder = useDeleteFolder()
  const deleteNote = useDeleteNote()

  const folders = tree.data?.folders
  const notes = tree.data?.notes
  const items = useMemo(() => (folders && notes ? buildTree(folders, notes) : []), [folders, notes])

  const selectedFolder = folders?.find((f) => f.id === selectedFolderId)
  const selectedId = selectedFolder?.id ?? openNoteId
  const openNoteFolderId = notes?.find((n) => n.id === openNoteId)?.folder_id ?? null
  // where "New note" / "New folder" create: the selected folder, else the open note's folder (if it still
  // exists), else the root
  const targetFolder = selectedFolder ?? folders?.find((f) => f.id === openNoteFolderId)
  const targetFolderId = targetFolder?.id ?? null

  const openNote = (id: string) => {
    setSelectedFolderId(null)
    showNote(id)
  }

  const commitRename = (item: TreeItem, value: string) => {
    setRenamingId(null)
    if (item.kind === 'folder') {
      const name = value.trim()
      // an empty folder name is not allowed: keep the old one
      if (name && name !== item.folder.name) renameFolder.mutate({ id: item.id, name })
    } else if (value !== item.note.title) {
      renameNote.mutate({ id: item.id, title: value })
    }
  }

  const move = (item: TreeItem, target: string | null) => {
    if (item.kind === 'folder') moveFolder.mutate({ id: item.id, parentFolderId: target })
    else moveNote.mutate({ id: item.id, folderId: target })
    // keep the moved item in view
    if (target) expand(target)
  }

  const remove = (item: TreeItem) => {
    if (item.kind === 'folder') {
      const removed = subtreeFolderIds(folders ?? [], item.id)
      if (openNoteFolderId && removed.has(openNoteFolderId)) closeNote()
      if (selectedFolderId && removed.has(selectedFolderId)) setSelectedFolderId(null)
      deleteFolder.mutate({ id: item.id })
    } else {
      if (item.id === openNoteId) closeNote()
      deleteNote.mutate({ id: item.id })
    }
  }

  const handlers: TreeHandlers = {
    onFolderClick: (id) => {
      setSelectedFolderId(id)
      toggle(id)
    },
    onNoteClick: openNote,
    onRename: (item) => setRenamingId(item.id),
    onRenameCommit: commitRename,
    onRenameCancel: () => setRenamingId(null),
    onMove: setMoving,
    onDelete: setDeleting,
  }

  const newNote = (folderId: string | null) =>
    createNote.mutate(
      { folderId },
      {
        onSuccess: ({ note }) => {
          if (folderId) expand(folderId)
          openNote(note.id)
        },
      },
    )

  const newFolder = (parentFolderId: string | null) =>
    createFolder.mutate(
      { parentFolderId },
      {
        onSuccess: ({ folder }) => {
          if (parentFolderId) expand(parentFolderId)
          setSelectedFolderId(folder.id)
          // created with a default name: let the user type the real one right away
          setRenamingId(folder.id)
        },
      },
    )

  const creating = createNote.isPending || createFolder.isPending

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-tight">Notes</div>
          <div className="truncate text-xs text-muted-foreground">{targetFolder ? `in ${targetFolder.name}` : 'at root'}</div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New note"
          title="New note"
          disabled={creating}
          onClick={() => newNote(targetFolderId)}
        >
          <FilePlusIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New folder"
          title="New folder"
          disabled={creating}
          onClick={() => newFolder(targetFolderId)}
        >
          <FolderPlusIcon />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {tree.isPending ? (
          <TreeSkeleton />
        ) : tree.isError ? (
          <div className="space-y-2 p-2 text-sm">
            <p className="text-muted-foreground">Could not load your notes.</p>
            <Button variant="outline" size="sm" onClick={() => tree.refetch()}>
              Retry
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="space-y-3 p-2 text-sm">
            <h2 className="font-semibold">Welcome to Notes</h2>
            <p className="text-muted-foreground">
              You have no notes yet. Create a note to start writing, or a folder to organize your notes.
            </p>
            <Button size="sm" disabled={creating} onClick={() => newNote(null)}>
              <FilePlusIcon />
              Create your first note
            </Button>
          </div>
        ) : (
          <TreeDnd tree={tree.data} onMove={move}>
            <ul role="tree" aria-label="Folders and notes">
              {items.map((item) => (
                <TreeNode
                  key={item.id}
                  item={item}
                  expanded={expanded}
                  selectedId={selectedId}
                  renamingId={renamingId}
                  handlers={handlers}
                />
              ))}
            </ul>
            <RootDropZone />
          </TreeDnd>
        )}
      </div>

      <div className="flex shrink-0 gap-1 border-t px-2 py-1">
        <Button variant="ghost" size="xs" disabled={creating} onClick={() => newNote(null)} aria-label="New note at root">
          <FilePlusIcon />
          Note at root
        </Button>
        <Button variant="ghost" size="xs" disabled={creating} onClick={() => newFolder(null)} aria-label="New folder at root">
          <FolderPlusIcon />
          Folder at root
        </Button>
      </div>

      <MoveDialog item={moving} tree={tree.data} onOpenChange={(open) => !open && setMoving(null)} onMove={move} />
      <DeleteDialog item={deleting} tree={tree.data} onOpenChange={(open) => !open && setDeleting(null)} onConfirm={remove} />
    </>
  )
}

function TreeSkeleton() {
  return (
    <div role="status" aria-label="Loading folders and notes" className="space-y-2 p-1">
      {[70, 55, 80, 45, 60].map((width, i) => (
        <div key={i} className="h-5 animate-pulse rounded bg-muted" style={{ width: `${width}%` }} />
      ))}
    </div>
  )
}
