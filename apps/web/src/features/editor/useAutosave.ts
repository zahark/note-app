import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { JSONContent } from '@tiptap/core'
import { meQueryKey } from '@/features/auth/api'
import { ApiError, isUnauthorized } from '@/lib/api'
import { saveNoteContent } from './api'

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
  /** Debounce after the last change, in ms. */
  delay?: number
  /** Wait before retrying a failed save, in ms. */
  retryDelay?: number
}

/**
 * Failures worth retrying on a timer: network errors, server errors and rate limits. Others (a lost
 * session, a deleted note, a rejected body) would fail again; the next edit tries again instead.
 */
const isTransient = (err: unknown): boolean =>
  !(err instanceof ApiError) || err.status === 0 || err.status === 429 || err.status >= 500

export const AUTOSAVE_DELAY_MS = 1000
export const AUTOSAVE_RETRY_MS = 5000

/**
 * Debounced, serialized content saves for one note.
 *
 * Each change replaces the pending content and restarts the debounce. When it fires, the pending
 * content is sent with the current `version`; a save never starts while another is in flight, and
 * whatever is pending when it finishes (the latest content) is sent next. Each successful save
 * adopts the `version` the server returns. A 409 stops saving (`conflict`); any other failure keeps
 * the content pending (`error`) and, if it looks transient, retries after `retryDelay`.
 */
export class Autosaver {
  private readonly options: AutosaverOptions
  private readonly delay: number
  private readonly retryDelay: number
  private version: number
  private pending: JSONContent | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight = false
  /** A flush was requested while a save was in flight: run it as soon as that save ends. */
  private flushQueued = false
  private failed = false
  private conflicted = false
  private status: SaveStatus = 'saved'

  constructor(options: AutosaverOptions) {
    this.options = options
    this.version = options.version
    this.delay = options.delay ?? AUTOSAVE_DELAY_MS
    this.retryDelay = options.retryDelay ?? AUTOSAVE_RETRY_MS
  }

  get currentVersion(): number {
    return this.version
  }

  get currentStatus(): SaveStatus {
    return this.status
  }

  /** Whether some change is not on the server yet. */
  get hasUnsavedChanges(): boolean {
    return this.pending !== null || this.inFlight
  }

  /** Records a change; it is saved once no other change arrives for `delay` ms. */
  schedule = (content: JSONContent): void => {
    if (this.conflicted) return
    this.pending = content
    this.restartTimer(this.delay)
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
        if (isTransient(err) && this.timer === undefined && !this.flushQueued) this.restartTimer(this.retryDelay)
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
  /** Defaults to `PUT /api/notes/:id/content`. */
  save?: (noteId: string, content: JSONContent, version: number) => Promise<{ version: number }>
  delay?: number
  retryDelay?: number
}

/**
 * Autosave for the open note (the editor is remounted per note, so `noteId` and the initial
 * `version` are read once). Pending changes are flushed when the editor unmounts or the tab is
 * hidden, and closing the tab with unsaved changes asks for confirmation. A lost session sends the
 * user to the login page like any other request.
 */
export function useAutosave({ noteId, version, save = saveNoteContent, delay, retryDelay }: UseAutosaveOptions) {
  const client = useQueryClient()
  const [status, setStatus] = useState<SaveStatus>('saved')
  const [saver] = useState(
    () =>
      new Autosaver({
        version,
        save: (content, v) => save(noteId, content, v),
        onStatus: setStatus,
        onError: (err) => {
          if (isUnauthorized(err)) client.setQueryData(meQueryKey, null)
        },
        delay,
        retryDelay,
      }),
  )

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') saver.flush()
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!saver.hasUnsavedChanges) return
      saver.flush()
      event.preventDefault()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
      // leaving the note: save what is pending instead of waiting for the debounce
      saver.flush()
    }
  }, [saver])

  return { status, schedule: saver.schedule, flush: saver.flush, saver }
}
