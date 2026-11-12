import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { errorMessage, treeQueryKey } from './api'
import { subtreeFolderIds, type TreeData, type TreeFolder, type TreeNote } from './buildTree'

interface OptimisticTreeMutation<TVars, TResult> {
  mutationFn: (vars: TVars) => Promise<TResult>
  /** The change applied to the cached tree before the request is sent. */
  apply: (tree: TreeData, vars: TVars) => TreeData
  /** Folds the server's response into the cached tree once the request succeeds. */
  reconcile?: (tree: TreeData, result: TResult) => TreeData
  /** Toast prefix on failure, e.g. "Could not rename folder". */
  failure: string
}

/**
 * A tree mutation that updates the cached `GET /api/tree` data at once and, if the server rejects
 * it, restores the previous tree, shows an error toast and refetches (another mutation may have
 * changed the tree in the meantime, so the server's copy is the one to trust).
 */
function useOptimisticTreeMutation<TVars, TResult>({
  mutationFn,
  apply,
  reconcile,
  failure,
}: OptimisticTreeMutation<TVars, TResult>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn,
    onMutate: async (vars: TVars) => {
      // a tree fetch landing after the optimistic write would undo it
      await client.cancelQueries({ queryKey: treeQueryKey })
      const previous = client.getQueryData<TreeData>(treeQueryKey)
      if (previous) client.setQueryData<TreeData>(treeQueryKey, apply(previous, vars))
      return { previous }
    },
    onError: (err, _vars, context) => {
      if (context?.previous) client.setQueryData<TreeData>(treeQueryKey, context.previous)
      toast.error(`${failure}: ${errorMessage(err)}`)
      void client.invalidateQueries({ queryKey: treeQueryKey })
    },
    onSuccess: (result) => {
      if (reconcile) client.setQueryData<TreeData>(treeQueryKey, (tree) => tree && reconcile(tree, result))
    },
  })
}

const replaceFolder = (tree: TreeData, folder: TreeFolder): TreeData => ({
  ...tree,
  folders: tree.folders.map((f) => (f.id === folder.id ? folder : f)),
})

const replaceNote = (tree: TreeData, note: TreeNote): TreeData => ({
  ...tree,
  notes: tree.notes.map((n) => (n.id === note.id ? note : n)),
})

const patchFolder = (tree: TreeData, id: string, patch: Partial<TreeFolder>): TreeData => ({
  ...tree,
  folders: tree.folders.map((f) => (f.id === id ? { ...f, ...patch } : f)),
})

const patchNote = (tree: TreeData, id: string, patch: Partial<TreeNote>): TreeData => ({
  ...tree,
  notes: tree.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
})

/** The tree without folder `id`, its subfolders and every note in them (what the server's cascade deletes). */
export function removeFolderFromTree(tree: TreeData, id: string): TreeData {
  const removed = subtreeFolderIds(tree.folders, id)
  return {
    folders: tree.folders.filter((f) => !removed.has(f.id)),
    notes: tree.notes.filter((n) => n.folder_id === null || !removed.has(n.folder_id)),
  }
}

type FolderResponse = { folder: TreeFolder }
type NoteResponse = { note: TreeNote }

export function useRenameFolder() {
  return useOptimisticTreeMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch<FolderResponse>(`/api/folders/${encodeURIComponent(id)}`, { name }),
    apply: (tree, { id, name }) => patchFolder(tree, id, { name }),
    reconcile: (tree, { folder }) => replaceFolder(tree, folder),
    failure: 'Could not rename folder',
  })
}

/** Renames a note through the metadata endpoint (never sends or changes the content `version`). */
export function useRenameNote() {
  return useOptimisticTreeMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<NoteResponse>(`/api/notes/${encodeURIComponent(id)}`, { title }),
    apply: (tree, { id, title }) => patchNote(tree, id, { title }),
    reconcile: (tree, { note }) => replaceNote(tree, note),
    failure: 'Could not rename note',
  })
}

/** Moves a folder under `parentFolderId` (null = root); the server rejects cycles with 409. */
export function useMoveFolder() {
  return useOptimisticTreeMutation({
    mutationFn: ({ id, parentFolderId }: { id: string; parentFolderId: string | null }) =>
      api.patch<FolderResponse>(`/api/folders/${encodeURIComponent(id)}/move`, { parent_folder_id: parentFolderId }),
    apply: (tree, { id, parentFolderId }) => patchFolder(tree, id, { parent_folder_id: parentFolderId }),
    reconcile: (tree, { folder }) => replaceFolder(tree, folder),
    failure: 'Could not move folder',
  })
}

/** Moves a note into `folderId` (null = root). */
export function useMoveNote() {
  return useOptimisticTreeMutation({
    mutationFn: ({ id, folderId }: { id: string; folderId: string | null }) =>
      api.patch<NoteResponse>(`/api/notes/${encodeURIComponent(id)}/move`, { folder_id: folderId }),
    apply: (tree, { id, folderId }) => patchNote(tree, id, { folder_id: folderId }),
    reconcile: (tree, { note }) => replaceNote(tree, note),
    failure: 'Could not move note',
  })
}

/** Deletes a folder with everything in it. */
export function useDeleteFolder() {
  return useOptimisticTreeMutation({
    mutationFn: ({ id }: { id: string }) => api.delete<void>(`/api/folders/${encodeURIComponent(id)}`),
    apply: (tree, { id }) => removeFolderFromTree(tree, id),
    failure: 'Could not delete folder',
  })
}

export function useDeleteNote() {
  return useOptimisticTreeMutation({
    mutationFn: ({ id }: { id: string }) => api.delete<void>(`/api/notes/${encodeURIComponent(id)}`),
    apply: (tree, { id }) => ({ ...tree, notes: tree.notes.filter((n) => n.id !== id) }),
    failure: 'Could not delete note',
  })
}
