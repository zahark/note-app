import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, errorMessage } from '@/lib/api'
import type { Note } from '@/features/editor/api'

/** A folder as returned by `GET /api/tree`. */
export interface TreeFolder {
  id: string
  name: string
  /** null = root. */
  parent_folder_id: string | null
  created_at: number
}

/** A note summary (no content) as returned by `GET /api/tree`. */
export interface TreeNote {
  id: string
  /** null = root. */
  folder_id: string | null
  title: string
  version: number
  created_at: number
  updated_at: number
  share_type: 'private' | 'password_protected' | 'signed_url'
  expires_at: number | null
}

/** `GET /api/tree` response: two flat lists. */
export interface TreeData {
  folders: TreeFolder[]
  notes: TreeNote[]
}

export const treeQueryKey = ['tree'] as const

/**
 * How long a loaded tree counts as fresh. The app keeps its own copy current (every tree change is
 * written to the cache optimistically and failures refetch), so components mounting (e.g. each note
 * opened) must not refetch it: a fetch racing a mutation could bring back the tree from before it.
 * Changes made on another device show up after this long, on the next mount, or on reload.
 */
export const TREE_STALE_MS = 5 * 60 * 1000

/** The caller's folders and notes as flat lists (`GET /api/tree`). */
export function useTree() {
  return useQuery({
    queryKey: treeQueryKey,
    queryFn: ({ signal }) => api.get<TreeData>('/api/tree', signal),
    staleTime: TREE_STALE_MS,
  })
}

/** Name given to a folder created from the sidebar (renamed inline afterwards). */
export const NEW_FOLDER_NAME = 'New folder'

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
      api.post<{ note: Note }>('/api/notes', { folder_id: folderId }),
    onSuccess: ({ note }) => {
      // the tree only holds summaries: drop the content the create response carries
      const { content: _content, ...summary } = note
      client.setQueryData<TreeData>(treeQueryKey, (tree) => tree && { ...tree, notes: [...tree.notes, summary] })
    },
    onError: (err) => toast.error(`Could not create note: ${errorMessage(err)}`),
  })
}
