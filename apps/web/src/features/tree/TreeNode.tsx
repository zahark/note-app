import { useEffect, useRef, useState } from 'react'
import { ChevronRightIcon, FileTextIcon, FolderIcon, FolderOpenIcon } from 'lucide-react'
import { cn } from 'cn'
import type { TreeItem } from './buildTree'
import { TreeItemContextMenu, TreeItemMenuButton } from './ContextMenu'
import { MAX_NAME_LENGTH, TREE_INDENT_PX } from './treeOps'
import { useTreeRowDnd, type DropHighlight } from './useTreeRowDnd'

/** Callbacks shared by every row of the tree. */
export interface TreeHandlers {
  onFolderClick: (id: string) => void
  onNoteClick: (id: string) => void
  /** Puts the row into inline-rename mode. */
  onRename: (item: TreeItem) => void
  /** Ends inline rename with the field's value (the caller decides whether anything changed). */
  onRenameCommit: (item: TreeItem, value: string) => void
  onRenameCancel: () => void
  onMove: (item: TreeItem) => void
  onDelete: (item: TreeItem) => void
}

export interface TreeNodeProps {
  item: TreeItem
  expanded: ReadonlySet<string>
  /** Id of the selected folder or note, if any. */
  selectedId: string | null
  /** Id of the row being renamed inline, if any. */
  renamingId: string | null
  handlers: TreeHandlers
}

/** Drop-target styling during a drag: the hovered folder is highlighted, unreachable ones dimmed. */
const dropHighlightClass = (highlight: DropHighlight) =>
  cn(highlight === 'over' && 'bg-primary/15 ring-2 ring-primary/60', highlight === 'invalid' && 'opacity-40')

/** One folder (with its children when expanded) or note row of the sidebar tree. */
export function TreeNode({ item, expanded, selectedId, renamingId, handlers }: TreeNodeProps) {
  const isFolder = item.kind === 'folder'
  const isOpen = isFolder && expanded.has(item.id)
  const isSelected = selectedId === item.id
  const isRenaming = renamingId === item.id
  const indent = { paddingLeft: item.depth * TREE_INDENT_PX + 4 }
  const { setDragRef, dragAttributes, dragListeners, isDragging, setDropRef, highlight } = useTreeRowDnd(item, isRenaming)
  const actions = {
    onRename: () => handlers.onRename(item),
    onMove: () => handlers.onMove(item),
    onDelete: () => handlers.onDelete(item),
  }

  const icon = isFolder ? (
    <>
      <ChevronRightIcon className={cn('size-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')} />
      {isOpen ? <FolderOpenIcon className="size-4 shrink-0" /> : <FolderIcon className="size-4 shrink-0" />}
    </>
  ) : (
    <FileTextIcon className="ml-5 size-4 shrink-0 text-muted-foreground" />
  )

  return (
    <li
      role="treeitem"
      aria-label={item.name}
      aria-level={item.depth + 1}
      aria-selected={isSelected}
      aria-expanded={isFolder ? isOpen : undefined}
    >
      <TreeItemContextMenu {...actions}>
        <div
          ref={setDropRef}
          data-tree-row=""
          data-drop-target={highlight}
          className={cn(
            'group/row flex h-7 items-center rounded-md pr-1 hover:bg-sidebar-accent',
            isSelected && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
            isDragging && 'opacity-50',
            dropHighlightClass(highlight),
          )}
        >
          {isRenaming ? (
            <div className="flex min-w-0 flex-1 items-center gap-1.5" style={indent}>
              {icon}
              <RenameInput
                initial={item.kind === 'folder' ? item.folder.name : item.note.title}
                label={`Rename ${item.kind}`}
                maxLength={MAX_NAME_LENGTH[item.kind]}
                onCommit={(value) => handlers.onRenameCommit(item, value)}
                onCancel={handlers.onRenameCancel}
              />
            </div>
          ) : (
            <button
              ref={setDragRef}
              {...dragAttributes}
              {...dragListeners}
              type="button"
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              style={indent}
              onClick={() => (isFolder ? handlers.onFolderClick(item.id) : handlers.onNoteClick(item.id))}
              onKeyDown={(event) => {
                // Space picks the row up for a keyboard drag
                dragListeners?.onKeyDown?.(event)
                if (event.key === 'F2') {
                  event.preventDefault()
                  handlers.onRename(item)
                }
              }}
              // Space is the drag key, so it must not also click the row (Enter still does)
              onKeyUp={(event) => event.key === ' ' && event.preventDefault()}
            >
              {icon}
              <span className="truncate">{item.name}</span>
            </button>
          )}
          <TreeItemMenuButton
            name={item.name}
            {...actions}
            className="opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
          />
        </div>
      </TreeItemContextMenu>
      {item.kind === 'folder' &&
        isOpen &&
        (item.children.length > 0 ? (
          <ul role="group">
            {item.children.map((child) => (
              <TreeNode
                key={child.id}
                item={child}
                expanded={expanded}
                selectedId={selectedId}
                renamingId={renamingId}
                handlers={handlers}
              />
            ))}
          </ul>
        ) : (
          <p className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: (item.depth + 1) * TREE_INDENT_PX + 24 }}>
            Empty folder
          </p>
        ))}
    </li>
  )
}

interface RenameInputProps {
  initial: string
  label: string
  maxLength: number
  onCommit: (value: string) => void
  onCancel: () => void
}

/** Inline name field: Enter or leaving the field saves, Escape cancels. */
function RenameInput({ initial, label, maxLength, onCommit, onCancel }: RenameInputProps) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  // Enter/Escape end the rename before the field unmounts, and the blur that follows must not commit again
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(value)
    else onCancel()
  }

  return (
    <input
      ref={ref}
      aria-label={label}
      value={value}
      maxLength={maxLength}
      className="h-6 min-w-0 flex-1 rounded-sm border bg-background px-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          finish(false)
        }
      }}
    />
  )
}
