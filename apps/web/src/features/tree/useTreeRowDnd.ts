import { createContext, useContext } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import type { TreeItem } from './buildTree'
import type { DropStatus } from './treeOps'

/** What a draggable row carries (`active.data.current`). */
export interface DragData {
  item: TreeItem
}

/** What a drop target carries (`over.data.current`). */
export interface DropData {
  /** Target folder id; null = root. */
  target: string | null
  label: string
}

export interface TreeDndState {
  /** The item being dragged, if any. */
  active: TreeItem | null
  statusOf: (target: string | null) => DropStatus
}

/** Provided by `TreeDnd` (`dnd.tsx`): the current drag and the drop rules for it. */
export const TreeDndContext = createContext<TreeDndState>({ active: null, statusOf: () => 'invalid' })

/** How a row looks as a drop target during a drag. */
export type DropHighlight = 'over' | 'valid' | 'invalid' | undefined

/**
 * Drag source for a tree row, and drop target if it is a folder. A folder is only an enabled drop
 * target while a drag is on and the dragged item may go into it, so the collision detection and
 * the keyboard never land on the dragged folder, its descendants or the item's own folder.
 */
export function useTreeRowDnd(item: TreeItem, disabled: boolean) {
  const { active, statusOf } = useContext(TreeDndContext)
  const {
    setNodeRef: setDragRef,
    attributes: dragAttributes,
    listeners: dragListeners,
    isDragging,
  } = useDraggable({ id: item.id, data: { item } satisfies DragData, disabled })
  const status = item.kind === 'folder' && active ? statusOf(item.id) : undefined
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: item.id,
    data: { target: item.id, label: item.name } satisfies DropData,
    disabled: status !== 'valid',
  })
  const highlight: DropHighlight =
    status === 'valid' ? (isOver ? 'over' : 'valid') : status === 'invalid' ? 'invalid' : undefined
  return { setDragRef, dragAttributes, dragListeners, isDragging, setDropRef, highlight }
}
