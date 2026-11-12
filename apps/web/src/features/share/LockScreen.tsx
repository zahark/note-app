import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { LockIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError } from '@/lib/api'
import { unlockSharedNote } from './api'

interface LockScreenProps {
  noteId: string
  /** Called with the read token after a successful unlock; the caller keeps it in memory only. */
  onUnlock: (token: string) => void
}

/** Wrong PIN, missing, private or link-only note: one message, so nothing is revealed. */
export const GENERIC_UNLOCK_ERROR = 'That PIN did not work, or this note is no longer shared.'

/** The message for a failed unlock. Only a lockout (429) and an unreachable server differ from the generic one. */
function unlockErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      if (err.retryAfter === undefined) return 'Too many attempts. Try again later.'
      const minutes = Math.max(1, Math.ceil(err.retryAfter / 60))
      return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
    }
    if (err.status === 0 || err.status >= 500) return 'Could not unlock right now. Try again in a moment.'
  }
  return GENERIC_UNLOCK_ERROR
}

/** Asks for the PIN of a PIN-shared note and exchanges it for a read token. */
export function LockScreen({ noteId, onUnlock }: LockScreenProps) {
  const [pin, setPin] = useState('')
  const unlock = useMutation({
    mutationFn: (value: string) => unlockSharedNote(noteId, value),
    onSuccess: ({ token }) => onUnlock(token),
    onError: () => setPin(''),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (pin.trim() !== '' && !unlock.isPending) unlock.mutate(pin)
  }

  const error = unlock.isError ? unlockErrorMessage(unlock.error) : null

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border p-6" aria-label="Unlock shared note">
        <div className="flex items-center gap-2">
          <LockIcon className="size-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">This note is protected</h1>
        </div>
        <p className="text-sm text-muted-foreground">Enter the PIN you were given to read it.</p>
        <div className="space-y-2">
          <Label htmlFor="share-pin">PIN</Label>
          <Input
            id="share-pin"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={64}
            autoFocus
            aria-invalid={error !== null}
            aria-describedby={error ? 'share-pin-error' : undefined}
            className="font-mono tracking-widest uppercase"
          />
          {error && (
            <p id="share-pin-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" className="w-full" disabled={pin.trim() === '' || unlock.isPending}>
          {unlock.isPending ? 'Unlocking…' : 'Unlock'}
        </Button>
      </form>
    </main>
  )
}
