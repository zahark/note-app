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
import { deleteDescription } from './treeOps'

interface DeleteDialogProps {
  /** The folder or note to delete; null = dialog closed. */
  item: TreeItem | null
  tree: TreeData | undefined
  onOpenChange: (open: boolean) => void
  onConfirm: (item: TreeItem) => void
}

/** Delete confirmation; for a folder it states how many subfolders and notes go with it. */
export function DeleteDialog({ item, tree, onOpenChange, onConfirm }: DeleteDialogProps) {
  return (
    <Dialog open={item !== null && tree !== undefined} onOpenChange={onOpenChange}>
      <DialogContent>
        {item && tree && (
          <>
            <DialogHeader>
              <DialogTitle>
                Delete {item.kind} “{item.name}”?
              </DialogTitle>
              <DialogDescription>{deleteDescription(tree, item)}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  onConfirm(item)
                  onOpenChange(false)
                }}
              >
                Delete
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
