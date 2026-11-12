import { ChevronRightIcon, FileTextIcon, FolderIcon, FolderOpenIcon } from 'lucide-react'
import { cn } from 'cn'
import type { TreeItem } from './buildTree'

export interface TreeNodeProps {
  item: TreeItem
  expanded: ReadonlySet<string>
  /** Id of the selected folder or note, if any. */
  selectedId: string | null
  onFolderClick: (id: string) => void
  onNoteClick: (id: string) => void
}

const INDENT_PX = 12

/** One folder (with its children when expanded) or note row of the sidebar tree. */
export function TreeNode({ item, expanded, selectedId, onFolderClick, onNoteClick }: TreeNodeProps) {
  const isFolder = item.kind === 'folder'
  const isOpen = isFolder && expanded.has(item.id)
  const isSelected = selectedId === item.id
  const indent = { paddingLeft: item.depth * INDENT_PX + 4 }

  return (
    <li
      role="treeitem"
      aria-label={item.name}
      aria-level={item.depth + 1}
      aria-selected={isSelected}
      aria-expanded={isFolder ? isOpen : undefined}
    >
      <button
        type="button"
        className={cn(
          'flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-sm outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50',
          isSelected && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
        )}
        style={indent}
        onClick={() => (isFolder ? onFolderClick(item.id) : onNoteClick(item.id))}
      >
        {isFolder ? (
          <>
            <ChevronRightIcon className={cn('size-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')} />
            {isOpen ? <FolderOpenIcon className="size-4 shrink-0" /> : <FolderIcon className="size-4 shrink-0" />}
          </>
        ) : (
          <FileTextIcon className="ml-5 size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{item.name}</span>
      </button>
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
                onFolderClick={onFolderClick}
                onNoteClick={onNoteClick}
              />
            ))}
          </ul>
        ) : (
          <p className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: (item.depth + 1) * INDENT_PX + 24 }}>
            Empty folder
          </p>
        ))}
    </li>
  )
}
