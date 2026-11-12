import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { TreeData, TreeFolder, TreeNote } from './buildTree'

export const treeQueryKey = ['tree'] as const

/** The caller's folders and notes as flat lists (`GET /api/tree`). */
export function useTree() {
  return useQuery({
    queryKey: treeQueryKey,
    queryFn: ({ signal }) => api.get<TreeData>('/api/tree', signal),
  })
}

/** Name given to a folder created from the sidebar (renamed inline afterwards). */
export const NEW_FOLDER_NAME = 'New folder'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong')

/** Creates a folder (in `parentFolderId`, or the root for null) and adds it to the cached tree. */
export function useCreateFolder() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ parentFolderId, name = NEW_FOLDER_NAME }: { parentFolderId: string | null; name?: string }) =>
      api.post<{ folder: TreeFolder }>('/api/folders', { name, parent_folder_id: parentFolderId }),
    onSuccess: ({ folder }) => {
      client.setQueryData<TreeData>(treeQueryKey, (tree) => tree && { ...tree, folders: [...tree.folders, folder] })
    },
    onError: (err) => toast.error(`Could not create folder: ${errorMessage(err)}`),
  })
}

/** Creates an empty note (in `folderId`, or the root for null) and adds it to the cached tree. */
export function useCreateNote() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ folderId }: { folderId: string | null }) =>
      api.post<{ note: TreeNote }>('/api/notes', { folder_id: folderId }),
    onSuccess: ({ note }) => {
      // the tree only holds summaries: drop the content the create response carries
      const { id, folder_id, title, version, created_at, updated_at, share_type, expires_at } = note
      const summary: TreeNote = { id, folder_id, title, version, created_at, updated_at, share_type, expires_at }
      client.setQueryData<TreeData>(treeQueryKey, (tree) => tree && { ...tree, notes: [...tree.notes, summary] })
    },
    onError: (err) => toast.error(`Could not create note: ${errorMessage(err)}`),
  })
}
