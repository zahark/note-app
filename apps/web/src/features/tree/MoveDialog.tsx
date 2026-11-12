import { useMemo, useState, type FormEvent } from 'react'
import { FolderIcon, HouseIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { TreeData } from './api'
import type { TreeItem } from './buildTree'
import { moveDestinations, TREE_INDENT_PX } from './treeOps'

interface MoveDialogProps {
  /** The folder or note being moved; null = dialog closed. */
  item: TreeItem | null
  tree: TreeData | undefined
  onOpenChange: (open: boolean) => void
  onMove: (item: TreeItem, target: string | null) => void
}

/** "Move to…" picker listing the root and every allowed folder; the current location is disabled. */
export function MoveDialog({ item, tree, onOpenChange, onMove }: MoveDialogProps) {
  return (
    <Dialog open={item !== null && tree !== undefined} onOpenChange={onOpenChange}>
      <DialogContent>
        {item && tree && (
          <MoveForm
            key={item.id}
            item={item}
            tree={tree}
            onMove={(target) => {
              onMove(item, target)
              onOpenChange(false)
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Radio value standing for the root (radio values are strings). */
const ROOT_VALUE = ''

function MoveForm({
  item,
  tree,
  onMove,
  onCancel,
}: {
  item: TreeItem
  tree: TreeData
  onMove: (target: string | null) => void
  onCancel: () => void
}) {
  const destinations = useMemo(() => moveDestinations(tree, item), [tree, item])
  // where the item is shown in the tree (an orphan is shown at the root), as for drag and drop
  const current = item.parentId
  const [selected, setSelected] = useState<string | null | undefined>(undefined)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (selected !== undefined && selected !== current) onMove(selected)
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Move “{item.name}”</DialogTitle>
        <DialogDescription>Choose where to move this {item.kind}.</DialogDescription>
      </DialogHeader>
      <fieldset className="max-h-72 overflow-auto rounded-md border p-1">
        <legend className="sr-only">Destination</legend>
        {destinations.map((dest) => {
          const isCurrent = dest.id === current
          const value = dest.id ?? ROOT_VALUE
          return (
            <label
              key={value}
              className="flex h-8 cursor-pointer items-center gap-2 rounded-md pr-2 text-sm has-checked:bg-accent has-focus-visible:ring-2 has-focus-visible:ring-ring/50 has-disabled:cursor-default has-disabled:opacity-50"
              style={{ paddingLeft: dest.depth * TREE_INDENT_PX + 8 }}
            >
              <input
                type="radio"
                name="move-destination"
                className="sr-only"
                value={value}
                aria-label={isCurrent ? `${dest.name} (current)` : dest.name}
                checked={selected === dest.id}
                disabled={isCurrent}
                onChange={() => setSelected(dest.id)}
              />
              {dest.id === null ? <HouseIcon className="size-4 shrink-0" /> : <FolderIcon className="size-4 shrink-0" />}
              <span className="truncate">{dest.name}</span>
              {isCurrent && <span className="ml-auto text-xs text-muted-foreground">(current)</span>}
            </label>
          )
        })}
      </fieldset>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={selected === undefined || selected === current}>
          Move
        </Button>
      </DialogFooter>
    </form>
  )
}
