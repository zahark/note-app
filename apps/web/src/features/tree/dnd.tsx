import { useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Active,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type Over,
} from '@dnd-kit/core'
import { FileTextIcon, FolderIcon, FolderUpIcon } from 'lucide-react'
import { cn } from 'cn'
import type { TreeData } from './api'
import type { TreeItem } from './buildTree'
import { dropRules } from './treeOps'
import { TreeDndContext, type DragData, type DropData } from './useTreeRowDnd'

/** Droppable id of the "move to root" zone (folder ids are UUIDs, so it can't collide). */
const ROOT_DROP_ID = '__root__'

/**
 * Pointer: the folder row under the cursor. Keyboard (no pointer): the droppable whose center is
 * closest to the dragged row, which the arrow keys move from one droppable to the next.
 */
const collisionDetection: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)

/**
 * Up/Down jump straight to the previous/next drop target (only enabled ones: valid folders and the
 * root zone) instead of moving a fixed number of pixels, so every press lands on a target.
 */
const keyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const { collisionRect, droppableRects, droppableContainers } = context
  if (!collisionRect || (event.code !== 'ArrowDown' && event.code !== 'ArrowUp')) return undefined
  event.preventDefault()
  const center = collisionRect.top + collisionRect.height / 2
  const centers = droppableContainers
    .getEnabled()
    .flatMap((container) => {
      const rect = droppableRects.get(container.id)
      return rect ? [rect.top + rect.height / 2] : []
    })
    .sort((a, b) => a - b)
  const next = event.code === 'ArrowDown' ? centers.find((y) => y > center + 1) : centers.findLast((y) => y < center - 1)
  return next === undefined ? undefined : { x: collisionRect.left, y: next - collisionRect.height / 2 }
}

// Space picks up and drops (Enter still opens the row), Escape cancels
const keyboardCodes = { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter', 'Tab'] }

const activeLabel = (active: Active) => (active.data.current as DragData | undefined)?.item.name ?? 'item'
const overLabel = (over: Over | null) => (over?.data.current as DropData | undefined)?.label

const announcements: Announcements = {
  onDragStart: ({ active }) => `Picked up ${activeLabel(active)}.`,
  onDragOver: ({ active, over }) => {
    const target = overLabel(over)
    return target ? `${activeLabel(active)} is over ${target}.` : `${activeLabel(active)} is not over a folder.`
  },
  onDragEnd: ({ active, over }) => {
    const target = overLabel(over)
    return target ? `${activeLabel(active)} was moved to ${target}.` : `${activeLabel(active)} was dropped where it was.`
  },
  onDragCancel: ({ active }) => `Moving ${activeLabel(active)} was cancelled.`,
}

const screenReaderInstructions = {
  draggable:
    'To move this item, press Space to pick it up, the up and down arrow keys to choose a folder, ' +
    'then Space to drop it there or Escape to cancel.',
}

interface TreeDndProps {
  tree: TreeData | undefined
  /** Called for a drop on a valid target (folder id, or null for the root). */
  onMove: (item: TreeItem, target: string | null) => void
  children: ReactNode
}

/**
 * Drag and drop for the sidebar tree: rows are dragged with the mouse (after moving 5 px, so clicks
 * still work) or the keyboard (Space, arrows, Space), and dropped on a folder row or the root zone.
 * Touch screens use the "…" menu's Move to… instead, so a long press keeps opening the menu.
 */
export function TreeDnd({ tree, onMove, children }: TreeDndProps) {
  const [active, setActive] = useState<TreeItem | null>(null)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { keyboardCodes, coordinateGetter: keyboardCoordinates }),
  )
  const statusOf = useMemo(() => (tree && active ? dropRules(tree, active) : () => 'invalid' as const), [tree, active])
  const state = useMemo(() => ({ active, statusOf }), [active, statusOf])

  const onDragStart = useCallback(({ active: a }: DragStartEvent) => {
    setActive((a.data.current as DragData | undefined)?.item ?? null)
  }, [])

  const onDragEnd = useCallback(
    ({ over }: DragEndEvent) => {
      setActive(null)
      const target = (over?.data.current as DropData | undefined)?.target
      // checked again here: a drop can land before the rows re-render with the drag's rules
      if (active && target !== undefined && statusOf(target) === 'valid') onMove(active, target)
    },
    [active, statusOf, onMove],
  )

  return (
    <TreeDndContext.Provider value={state}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        // the root zone appears once a drag starts, and the tree may scroll: measure while dragging
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        accessibility={{ announcements, screenReaderInstructions }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActive(null)}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {active && (
            <div data-drag-overlay="" className="flex h-7 max-w-60 items-center gap-1.5 rounded-md border bg-background px-2 text-sm shadow-md">
              {active.kind === 'folder' ? (
                <FolderIcon className="size-4 shrink-0" />
              ) : (
                <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{active.name}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </TreeDndContext.Provider>
  )
}

/** "Move to root" target, shown at the bottom of the tree while a drag is on. */
export function RootDropZone() {
  const { active, statusOf } = useContext(TreeDndContext)
  const valid = active !== null && statusOf(null) === 'valid'
  const { setNodeRef, isOver } = useDroppable({
    id: ROOT_DROP_ID,
    data: { target: null, label: 'the root' } satisfies DropData,
    disabled: !valid,
  })
  if (!active) return null
  return (
    <div
      ref={setNodeRef}
      data-tree-row=""
      data-drop-target={valid ? (isOver ? 'over' : 'valid') : undefined}
      aria-hidden
      className={cn(
        'sticky bottom-0 mt-1 flex h-8 items-center justify-center gap-1.5 rounded-md border border-dashed bg-sidebar text-xs text-muted-foreground',
        !valid && 'opacity-40',
        isOver && valid && 'border-primary bg-primary/15 text-foreground',
      )}
    >
      <FolderUpIcon className="size-4" />
      {valid ? 'Drop here to move to the root' : 'Already at the root'}
    </div>
  )
}
