import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CopyIcon, Share2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useTree, type TreeNote } from '@/features/tree/api'
import { displayTitle } from '@/features/tree/buildTree'
import { errorMessage } from '@/lib/api'
import {
  createShare,
  EXPIRY_OPTIONS,
  formatExpiry,
  setTreeShareState,
  sharedPageUrl,
  shareStatusText,
  stopSharing,
  type CreatedShare,
  type ExpiryOption,
  type ShareRequest,
} from './api'

/** The "Share" button of an open note; the note's share state is read from the tree when it is loaded. */
export function ShareButton({ note }: { note: TreeNote }) {
  const tree = useTree()
  const current = tree.data?.notes.find((n) => n.id === note.id) ?? note
  const [open, setOpen] = useState(false)
  const shared = current.share_type !== 'private'
  return (
    <>
      <Button
        variant={shared ? 'secondary' : 'outline'}
        size="sm"
        className="mt-1 shrink-0"
        onClick={() => setOpen(true)}
        title={shareStatusText(current)}
      >
        <Share2Icon />
        {shared ? 'Shared' : 'Share'}
      </Button>
      <ShareDialog note={current} open={open} onOpenChange={setOpen} />
    </>
  )
}

interface ShareDialogProps {
  note: TreeNote
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Share settings for a note: a PIN share (the PIN is shown once, right after it is created), or an
 * expiring signed link; creating either again regenerates it, and "Stop sharing" makes the note private.
 */
export function ShareDialog({ note, open, onOpenChange }: ShareDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* the panel unmounts when the dialog closes, which forgets the PIN or link it showed */}
        <SharePanel note={note} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.error('Could not copy to the clipboard')
  }
}

function SharePanel({ note, onDone }: { note: TreeNote; onDone: () => void }) {
  const client = useQueryClient()
  const [created, setCreated] = useState<CreatedShare | null>(null)
  const [expiry, setExpiry] = useState<ExpiryOption>('7d')

  const share = useMutation({
    mutationFn: (request: ShareRequest) => createShare(note.id, request),
    onSuccess: (result) => {
      setCreated(result)
      setTreeShareState(client, note.id, result.type, result.type === 'signed_url' ? result.exp : null)
    },
    onError: (err) => toast.error(`Could not share the note: ${errorMessage(err)}`),
  })
  const stop = useMutation({
    mutationFn: () => stopSharing(note.id),
    onSuccess: () => {
      setCreated(null)
      setTreeShareState(client, note.id, 'private', null)
      toast.success('Sharing stopped')
    },
    onError: (err) => toast.error(`Could not stop sharing: ${errorMessage(err)}`),
  })
  const busy = share.isPending || stop.isPending
  const isPin = note.share_type === 'password_protected'
  const isLink = note.share_type === 'signed_url'

  return (
    <>
      <DialogHeader>
        <DialogTitle>Share “{displayTitle(note.title)}”</DialogTitle>
        <DialogDescription data-testid="share-status">{shareStatusText(note)}</DialogDescription>
      </DialogHeader>

      {created && <CreatedShareDetails noteId={note.id} share={created} />}

      <section className="space-y-2" aria-labelledby="share-pin-heading">
        <h3 id="share-pin-heading" className="text-sm font-medium">
          Password (PIN)
        </h3>
        <p className="text-xs text-muted-foreground">Visitors need the link and an 8-character PIN. It does not expire.</p>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => share.mutate({ type: 'password_protected' })}
        >
          {isPin ? 'New PIN' : 'Create PIN'}
        </Button>
      </section>

      <section className="space-y-2" aria-labelledby="share-link-heading">
        <h3 id="share-link-heading" className="text-sm font-medium">
          Expiring link
        </h3>
        <p className="text-xs text-muted-foreground">Anyone with the link can read the note until it expires.</p>
        <div className="flex items-center gap-2">
          <select
            aria-label="Link expiry"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value as ExpiryOption)}
            className="h-7 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => share.mutate({ type: 'signed_url', expires_in: expiry })}
          >
            {isLink ? 'New link' : 'Create link'}
          </Button>
        </div>
      </section>

      {(isPin || isLink) && (
        <p className="text-xs text-muted-foreground">
          A note is shared one way at a time: a new PIN or link turns off the current one.
        </p>
      )}

      <DialogFooter>
        {(isPin || isLink) && (
          <Button variant="destructive" disabled={busy} onClick={() => stop.mutate()}>
            Stop sharing
          </Button>
        )}
        <Button variant="outline" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  )
}

/** The link (and PIN) just created. This is the only time a PIN is ever shown. */
function CreatedShareDetails({ noteId, share }: { noteId: string; share: CreatedShare }) {
  const link = share.type === 'signed_url' ? share.url : sharedPageUrl(noteId)
  return (
    <div className="space-y-3 rounded-lg border bg-muted/40 p-3" data-testid="created-share">
      <CopyField label="Link" value={link} onCopy={() => copyText(link, 'Link')} />
      {share.type === 'password_protected' ? (
        <>
          <CopyField label="PIN" value={share.pin} mono onCopy={() => copyText(share.pin, 'PIN')} />
          <p className="text-xs text-muted-foreground">
            Copy the PIN now: it is shown only once. Send the link and the PIN to the reader.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">This link works until {formatExpiry(share.exp)}.</p>
      )}
    </div>
  )
}

function CopyField({ label, value, mono, onCopy }: { label: string; value: string; mono?: boolean; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-xs font-medium">{label}</span>
      <Input
        readOnly
        aria-label={`Shared ${label.toLowerCase()}`}
        value={value}
        onFocus={(event) => event.target.select()}
        className={mono ? 'font-mono tracking-widest' : undefined}
      />
      <Button variant="outline" size="icon-sm" aria-label={`Copy ${label.toLowerCase()}`} onClick={onCopy}>
        <CopyIcon />
      </Button>
    </div>
  )
}
