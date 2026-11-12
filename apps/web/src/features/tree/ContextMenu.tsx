import { useRef, type ReactNode } from 'react'
import { FolderInputIcon, EllipsisIcon, PencilIcon, Trash2Icon, type LucideIcon } from 'lucide-react'
import { cn } from 'cn'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface ItemActions {
  onRename: () => void
  onMove: () => void
  onDelete: () => void
}

interface Action {
  label: string
  icon: LucideIcon
  run: () => void
  destructive?: boolean
}

const actionList = ({ onRename, onMove, onDelete }: ItemActions): Action[] => [
  { label: 'Rename', icon: PencilIcon, run: onRename },
  { label: 'Move to…', icon: FolderInputIcon, run: onMove },
  { label: 'Delete', icon: Trash2Icon, run: onDelete, destructive: true },
]

/**
 * Runs the chosen action only once the menu has closed, instead of returning focus to the menu's
 * trigger: the action moves focus itself (the inline rename field, or a dialog). Run while the
 * menu is still open, its focus trap would pull focus back and the closing menu would then drop it.
 */
function useDeferredAction() {
  const pending = useRef<(() => void) | null>(null)
  return {
    select: (run: () => void) => () => {
      pending.current = run
    },
    onCloseAutoFocus: (event: Event) => {
      const run = pending.current
      pending.current = null
      if (!run) return
      event.preventDefault()
      run()
    },
  }
}

interface TreeItemContextMenuProps extends ItemActions {
  /** The row; right-clicking it (or the context-menu key) opens the menu. */
  children: ReactNode
}

/** Right-click menu for a tree row: Rename, Move to…, Delete. */
export function TreeItemContextMenu({ children, ...actions }: TreeItemContextMenuProps) {
  const action = useDeferredAction()
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={action.onCloseAutoFocus}>
        {actionList(actions).map(({ label, icon: Icon, run, destructive }) => (
          <ContextMenuItem key={label} variant={destructive ? 'destructive' : 'default'} onSelect={action.select(run)}>
            <Icon />
            {label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface TreeItemMenuButtonProps extends ItemActions {
  /** The row's name, for the button's accessible label. */
  name: string
  className?: string
}

/** The row's "…" button opening the same actions as the right-click menu (the way in on touch screens). */
export function TreeItemMenuButton({ name, className, ...actions }: TreeItemMenuButtonProps) {
  const action = useDeferredAction()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${name}`}
        title="More actions"
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
          className,
        )}
      >
        <EllipsisIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={action.onCloseAutoFocus}>
        {actionList(actions).map(({ label, icon: Icon, run, destructive }) => (
          <DropdownMenuItem key={label} variant={destructive ? 'destructive' : 'default'} onSelect={action.select(run)}>
            <Icon />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
