import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createQueryClient } from '@/lib/queryClient'
import { mockFetch, type MockResponse } from '@/test/utils'
import { treeQueryKey, type TreeData, type TreeNote } from './api'
import { useMoveNote, useRenameNote } from './mutations'

const note = (patch: Partial<TreeNote> = {}): TreeNote => ({
  id: 'n1',
  title: 'Old',
  folder_id: null,
  version: 1,
  created_at: 1,
  updated_at: 1,
  share_type: 'private',
  expires_at: null,
  ...patch,
})

const tree: TreeData = { folders: [{ id: 'f1', name: 'Folder', parent_folder_id: null, created_at: 1 }], notes: [note()] }

describe('optimistic tree mutations', () => {
  it('a response arriving after a later mutation of the same item only updates the field it changed', async () => {
    let releaseRename!: (res: MockResponse) => void
    mockFetch({
      'PATCH /api/notes/n1': () => new Promise<MockResponse>((resolve) => (releaseRename = resolve)),
      'PATCH /api/notes/n1/move': { body: { note: note({ title: 'New', folder_id: 'f1', updated_at: 3 }) } },
    })
    const client = createQueryClient()
    client.setQueryData(treeQueryKey, tree)
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => ({ rename: useRenameNote(), move: useMoveNote() }), { wrapper })
    const cached = () => client.getQueryData<TreeData>(treeQueryKey)!.notes[0]!

    act(() => result.current.rename.mutate({ id: 'n1', title: 'New' }))
    await waitFor(() => expect(releaseRename).toBeTypeOf('function'))
    act(() => result.current.move.mutate({ id: 'n1', folderId: 'f1' }))
    await waitFor(() => expect(result.current.move.isSuccess).toBe(true))
    expect(cached()).toMatchObject({ title: 'New', folder_id: 'f1' })

    // the rename's row was read before the move: its folder is stale
    act(() => releaseRename({ body: { note: note({ title: 'New', folder_id: null, updated_at: 2 }) } }))
    await waitFor(() => expect(result.current.rename.isSuccess).toBe(true))
    expect(cached()).toMatchObject({ title: 'New', folder_id: 'f1' })
  })
})
