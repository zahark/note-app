import { useMemo, useState } from 'react'
import { FilePlusIcon, FolderPlusIcon } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { useCreateFolder, useCreateNote, useTree } from './api'
import { buildTree } from './buildTree'
import { TreeNode } from './TreeNode'
import { useExpanded } from './useExpanded'

/** Query-string key holding the open note's id (`/?note=<id>`). */
export const NOTE_PARAM = 'note'

/**
 * Sidebar: header with "New note" / "New folder" (created inside the selected folder, or the
 * selected note's folder), the collapsible folder tree, and persistent "new at root" buttons.
 */
export function Sidebar() {
  const tree = useTree()
  const createFolder = useCreateFolder()
  const createNote = useCreateNote()
  const { expanded, toggle, expand } = useExpanded()
  const [searchParams, setSearchParams] = useSearchParams()
  const openNoteId = searchParams.get(NOTE_PARAM)
  // a clicked folder takes the selection; otherwise the open note is the selection
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)

  const folders = tree.data?.folders
  const notes = tree.data?.notes
  const items = useMemo(() => (folders && notes ? buildTree(folders, notes) : []), [folders, notes])

  const selectedFolder = folders?.find((f) => f.id === selectedFolderId)
  const selectedId = selectedFolder?.id ?? openNoteId
  // where "New note" / "New folder" create: the selected folder, else the open note's folder, else the root
  const targetFolderId = selectedFolder
    ? selectedFolder.id
    : (notes?.find((n) => n.id === openNoteId)?.folder_id ?? null)
  const targetFolder = folders?.find((f) => f.id === targetFolderId)

  const openNote = (id: string) => {
    setSelectedFolderId(null)
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set(NOTE_PARAM, id)
      return next
    })
  }

  const onFolderClick = (id: string) => {
    setSelectedFolderId(id)
    toggle(id)
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
        },
      },
    )

  const creating = createNote.isPending || createFolder.isPending
  const target = targetFolder?.id ?? null

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-tight">Notes</div>
          <div className="truncate text-xs text-muted-foreground">{targetFolder ? `in ${targetFolder.name}` : 'at root'}</div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="New note" title="New note" disabled={creating} onClick={() => newNote(target)}>
          <FilePlusIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New folder"
          title="New folder"
          disabled={creating}
          onClick={() => newFolder(target)}
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
          <ul role="tree" aria-label="Folders and notes">
            {items.map((item) => (
              <TreeNode
                key={item.id}
                item={item}
                expanded={expanded}
                selectedId={selectedId}
                onFolderClick={onFolderClick}
                onNoteClick={openNote}
              />
            ))}
          </ul>
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
