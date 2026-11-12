import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { JSONContent } from '@tiptap/core'
import { toast } from 'sonner'
import { ApiError, errorMessage, isNotFound, isUnreachable } from '@/lib/api'
import { handleUnauthorized } from '@/lib/queryClient'
import { registerSaver, saveNoteContent, type RegisteredSaver } from './api'

/**
 * - `saved`: everything typed so far is on the server
 * - `pending`: changes are waiting for the debounce
 * - `saving`: a save is in flight
 * - `error`: the last save failed; it is retried
 * - `conflict`: the server has a newer version (409); saving stops until the note is reloaded
 */
export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict'

export type SaveContent = (content: JSONContent, version: number) => Promise<{ version: number }>

export interface AutosaverOptions {
  /** The version the editor's content was loaded at. */
  version: number
  save: SaveContent
  onStatus: (status: SaveStatus) => void
  /** Called with every failure other than a conflict (e.g. to handle a lost session). */
  onError?: (err: unknown) => void
}

/**
 * Failures worth retrying on a timer: network errors, server errors and rate limits. Others (a lost
 * session, a deleted note, a rejected body) would fail again; the next edit tries again instead.
 */
const isTransient = (err: unknown): boolean =>
  !(err instanceof ApiError) || isUnreachable(err) || err.status === 429

/** Debounce after the last change. */
export const AUTOSAVE_DELAY_MS = 1000
/** Wait before retrying a failed save. */
export const AUTOSAVE_RETRY_MS = 5000

/**
 * Debounced, serialized content saves for one note.
 *
 * Each change replaces the pending content and restarts the debounce. When it fires, the pending
 * content is sent with the current `version`; a save never starts while another is in flight, and
 * whatever is pending when it finishes (the latest content) is sent next. Each successful save
 * adopts the `version` the server returns. A 409 stops saving (`conflict`); any other failure keeps
 * the content pending (`error`) and, if it looks transient, retries after `AUTOSAVE_RETRY_MS`.
 */
export class Autosaver implements RegisteredSaver {
  private readonly options: AutosaverOptions
  private version: number
  private pending: JSONContent | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight = false
  /** A flush was requested while a save was in flight: run it as soon as that save ends. */
  private flushQueued = false
  private failed = false
  private conflicted = false
  private status: SaveStatus = 'saved'
  /** Re-checked whenever a save ends or the saver is cancelled (see `until`). */
  private readonly waiters = new Set<() => void>()
  private editorOpen = true

  constructor(options: AutosaverOptions) {
    this.options = options
    this.version = options.version
  }

  /** Whether some change is not on the server yet. */
  get hasUnsavedChanges(): boolean {
    return this.pending !== null || this.inFlight
  }

  /**
   * Nothing is left to save, or saving stopped: after a conflict, or after a failure that is not
   * retried on a timer (it would fail again) until the next change.
   */
  private get settled(): boolean {
    if (this.conflicted) return true
    if (this.inFlight || this.flushQueued) return false
    return this.pending === null || (this.failed && this.timer === undefined)
  }

  whenSettled = (): Promise<void> => this.until(() => this.settled)

  /** Whether an editor shows this note; false once it closed (the saver may still have work left). */
  get isOpen(): boolean {
    return this.editorOpen
  }

  /** The editor showing the note opened (again). */
  open = (): void => {
    this.editorOpen = true
  }

  /** The editor closed: what is pending is sent now instead of waiting for the debounce. */
  close = (): void => {
    this.editorOpen = false
    this.flush()
  }

  whenIdle = (): Promise<void> => this.until(() => !this.inFlight && !this.flushQueued)

  /** Records a change; it is saved once no other change arrives for `AUTOSAVE_DELAY_MS`. */
  schedule = (content: JSONContent): void => {
    if (this.conflicted) return
    this.pending = content
    this.restartTimer(AUTOSAVE_DELAY_MS)
    if (!this.inFlight && !this.failed) this.setStatus('pending')
  }

  /** Saves the pending content now (or right after the save in flight). */
  flush = (): void => {
    this.clearTimer()
    if (this.conflicted || this.pending === null) return
    if (this.inFlight) {
      this.flushQueued = true
      return
    }
    void this.run()
  }

  /** Stops timers; pending content is dropped (used after a conflict or by tests). */
  cancel = (): void => {
    this.clearTimer()
    this.pending = null
    this.flushQueued = false
    this.notify()
  }

  private async run(): Promise<void> {
    const content = this.pending!
    this.pending = null
    this.inFlight = true
    this.setStatus('saving')
    try {
      const { version } = await this.options.save(content, this.version)
      this.version = version
      this.failed = false
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        this.conflicted = true
        this.cancel()
      } else {
        this.failed = true
        // keep the content unless something newer is already waiting
        if (this.pending === null) this.pending = content
        // (a newer change already has its own debounce running)
        if (isTransient(err) && this.timer === undefined && !this.flushQueued) this.restartTimer(AUTOSAVE_RETRY_MS)
        this.options.onError?.(err)
      }
    } finally {
      this.inFlight = false
    }

    if (this.conflicted) {
      this.setStatus('conflict')
    } else if (this.flushQueued) {
      this.flushQueued = false
      this.flush()
    } else {
      this.setStatus(this.failed ? 'error' : this.pending !== null ? 'pending' : 'saved')
    }
    this.notify()
  }

  private until(done: () => boolean): Promise<void> {
    if (done()) return Promise.resolve()
    return new Promise((resolve) => {
      const check = () => {
        if (!done()) return
        this.waiters.delete(check)
        resolve()
      }
      this.waiters.add(check)
    })
  }

  private notify(): void {
    for (const check of [...this.waiters]) check()
  }

  private restartTimer(ms: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, ms)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private setStatus(status: SaveStatus): void {
    if (status === this.status) return
    this.status = status
    this.options.onStatus(status)
  }
}

export interface UseAutosaveOptions {
  noteId: string
  /** The version the note was loaded at. */
  version: number
}

/**
 * Autosave for the open note (the editor is remounted per note, so `noteId` and the initial
 * `version` are read once). Pending changes are flushed when the editor unmounts or the tab is
 * hidden, and closing the tab with unsaved changes asks for confirmation. A lost session sends the
 * user to the login page like any other request.
 *
 * The saver outlives the editor: after the editor closes it stays registered (unsaved-changes
 * prompt, sign-out flush, reopening the note waits for it) and keeps retrying until nothing is left
 * to save or saving stops for good; edits lost that way are reported in a toast.
 *
 * `error` is the server's message for a failure that retrying cannot fix (e.g. the note is too
 * large); it is cleared by the next successful save.
 */
export function useAutosave({ noteId, version }: UseAutosaveOptions) {
  const client = useQueryClient()
  const [status, setStatus] = useState<SaveStatus>('saved')
  const [error, setError] = useState<string | null>(null)
  const [saver] = useState(() => {
    const created: Autosaver = new Autosaver({
      version,
      save: (content, v) => saveNoteContent(noteId, content, v),
      onStatus: (next) => {
        if (next === 'saved') setError(null)
        if (next === 'conflict' && !created.isOpen) {
          toast.error('Your last edits to a closed note were not saved: it was changed somewhere else')
        }
        setStatus(next)
      },
      onError: (err) => {
        handleUnauthorized(client, err)
        setError(isTransient(err) ? null : errorMessage(err))
        // (no toast when the note itself was deleted)
        if (!created.isOpen && !isTransient(err) && !isNotFound(err)) {
          toast.error(`Your last edits to a closed note were not saved: ${errorMessage(err)}`)
        }
      },
    })
    return created
  })

  useEffect(() => {
    saver.open()
    const unregister = registerSaver(noteId, saver)
    return () => {
      saver.close()
      // unregistered only once its work is done (unless the editor came back meanwhile, as in StrictMode)
      void saver.whenSettled().then(() => {
        if (!saver.isOpen) unregister()
      })
    }
  }, [noteId, saver])

  return { status, schedule: saver.schedule, error }
}
