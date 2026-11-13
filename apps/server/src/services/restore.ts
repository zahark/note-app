// Restoring an off-site backup happens in two phases that share the layout below, all inside DATA_DIR (on
// Fly that is the volume, the only place that survives a restart):
//   1. `npm run restore:offsite -- <name>` (app still running) downloads and verifies a backup into
//      `restore-staging/`, writes `READY` last and renames the directory to `restore/`;
//   2. the next start swaps `restore/` into place before the database opens (`applyStagedRestore`), keeping
//      the previous data in `restore-previous/` until the swap is complete.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { DB_FILE_NAME } from '../db/index.js'

/** A complete, verified stage waiting for the next start. */
export const RESTORE_DIR = 'restore'
/**
 * Where the CLI assembles a stage; never read by the server. A leftover of an interrupted run is removed by
 * the next CLI run, or at the next start when no restore is armed and no CLI run holds the lock.
 */
export const RESTORE_STAGING_DIR = 'restore-staging'
/** Held by `restore:offsite` while it stages (it holds the CLI's pid), so two runs never share a stage. */
export const RESTORE_LOCK_FILE = 'restore-staging.lock'
/** The live data moved aside during a swap. */
export const RESTORE_PREVIOUS_DIR = 'restore-previous'
/** Written last into the stage: its presence means "every staged file is verified and on disk". */
export const RESTORE_READY_FILE = 'READY'

/** The JSON content of `READY`. */
export interface RestoreReady {
  /** Backup name (`notes-backup-YYYYMMDD-HHMMSS`). */
  name: string
  /** Size of the staged `notes.db`, checked again before a swap starts. */
  notesDbSize: number
  /** Number of files staged in `uploads/`. */
  uploadsCount: number
}

const readySchema = z.object({
  name: z.string().min(1),
  notesDbSize: z.number().int().min(0),
  uploadsCount: z.number().int().min(0),
})

const UPLOADS = 'uploads'
/** The staged items, in swap order. */
const SWAP_ITEMS = [DB_FILE_NAME, UPLOADS] as const
/** The database's WAL and shared-memory files: they belong to the old database and move aside with it. */
const DB_SIDE_FILES = [`${DB_FILE_NAME}-wal`, `${DB_FILE_NAME}-shm`] as const

/** fsync of a file or directory, so a rename or a crash never exposes data still in the page cache. */
export function fsyncPath(target: string): void {
  const fd = fs.openSync(target, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export interface RestoreLog {
  info(message: string): void
  warn(message: string): void
}

export interface ApplyRestoreOptions {
  /** `RESTORE_ABORT`: roll back a swap in progress and discard the stage instead of applying it. */
  abort: boolean
  log: RestoreLog
  /**
   * Test seam: called after every change on disk with a short description of it; throwing from it
   * simulates a crash right after that change.
   */
  afterStep?: (step: string) => void
}

/**
 * - `none`: nothing staged, nothing changed
 * - `cleaned`: leftovers of a finished swap (or a stage without `READY`) were removed
 * - `restored`: the staged backup is now the live data
 * - `discarded`: `abort` rolled back any swap in progress and deleted the stage
 */
export type RestoreOutcome = 'none' | 'cleaned' | 'restored' | 'discarded'

/** Applying or discarding a staged restore failed; the message says what to do (it stops startup). */
export class RestoreError extends Error {
  override name = 'RestoreError'
}

/** Whether anything (file, directory or even a dangling symlink) is at `p`. */
const present = (p: string): boolean => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined

/** Renames `from` to `to` (never over something already there) and fsyncs both parent directories. */
function move(from: string, to: string): void {
  if (present(to)) throw new Error(`${to} already exists; refusing to overwrite it with ${from}`)
  fs.renameSync(from, to)
  for (const dir of new Set([path.dirname(from), path.dirname(to)])) fsyncPath(dir)
}

/**
 * Removes a directory and everything in it. Interrupted half-way, what is left is still a leftover that the
 * next start removes (the callers only remove directories that are no longer needed).
 */
function removeDir(dir: string, step: (what: string) => void): void {
  fs.rmSync(dir, { recursive: true, force: true })
  fsyncPath(path.dirname(dir))
  step(`removed ${path.basename(dir)}/`)
}

/**
 * The pid in `restore-staging.lock` when that process is still running, else `null` (no lock, or one left
 * by a run that was killed).
 */
export function liveRestoreLockHolder(dataDir: string): number | null {
  let pid: number
  try {
    pid = Number(fs.readFileSync(path.join(dataDir, RESTORE_LOCK_FILE), 'utf8').trim())
  } catch {
    return null
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch (err) {
    // EPERM: the process exists but belongs to another user
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? pid : null
  }
}

function readReady(file: string): RestoreReady {
  let json: unknown
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`${file} is not readable JSON: ${(err as Error).message}`, { cause: err })
  }
  const parsed = readySchema.safeParse(json)
  if (!parsed.success) throw new Error(`${file} is not a valid restore marker`)
  return parsed.data
}

/**
 * Applies (or, with `abort`, discards) a restore staged by `restore:offsite`, before the database is
 * opened. Every step checks its own precondition, so running it again after a crash at any point finishes
 * the same swap (or the same rollback) and never moves a restored item aside. Throws a `RestoreError`
 * whose message ends with what to do next; the server must not open the database then.
 */
export function applyStagedRestore(dataDir: string, options: ApplyRestoreOptions): RestoreOutcome {
  try {
    return apply(dataDir, options)
  } catch (err) {
    const hint = options.abort
      ? 'RESTORE_ABORT is set, but the staged restore could not be rolled back and discarded; ' +
        `check ${path.join(dataDir, RESTORE_DIR)} and ${path.join(dataDir, RESTORE_PREVIOUS_DIR)} by hand.`
      : 'The database was not opened. To cancel the restore and keep the previous data, start the app once ' +
        'with RESTORE_ABORT=1 (on Fly.io: fly secrets set RESTORE_ABORT=1, then fly secrets unset RESTORE_ABORT).'
    throw new RestoreError(`Applying the staged restore failed: ${(err as Error).message}\n${hint}`, { cause: err })
  }
}

function apply(dataDir: string, { abort, log, afterStep }: ApplyRestoreOptions): RestoreOutcome {
  const staged = path.join(dataDir, RESTORE_DIR)
  const previous = path.join(dataDir, RESTORE_PREVIOUS_DIR)
  const readyFile = path.join(staged, RESTORE_READY_FILE)
  const step = (what: string) => afterStep?.(what)
  const live = (name: string) => path.join(dataDir, name)
  const inStage = (name: string) => path.join(staged, name)
  const kept = (name: string) => path.join(previous, name)

  if (!present(readyFile)) {
    // no restore armed: `restore/` without READY is a swap whose cleanup was interrupted (READY goes only
    // once every item is in place, and a rollback removes `restore-previous/` before READY), so
    // `restore-previous/` without READY is superseded data, and `restore-staging/` is what an interrupted
    // `restore:offsite` left (unless one is running right now). The live data is complete either way, so a
    // leftover that cannot be deleted (owned by another user, an I/O error) is only a warning: it must not
    // keep the app from starting. `restore:offsite` deletes `restore-previous/` and `restore-staging/`
    // itself before staging, and refuses while `restore/` exists, so a kept leftover never mixes into a swap.
    const staging = path.join(dataDir, RESTORE_STAGING_DIR)
    const leftovers = [staged, previous]
    if (liveRestoreLockHolder(dataDir) === null) leftovers.push(staging)
    const removed: string[] = []
    for (const dir of leftovers) {
      try {
        if (!present(dir)) continue
        fs.rmSync(dir, { recursive: true, force: true })
        fsyncPath(dataDir)
      } catch (err) {
        log.warn(
          `restore: could not remove ${dir}, left by an earlier restore (${(err as Error).message}); ` +
            'the live data is not affected. Delete it by hand.',
        )
        continue
      }
      step(`removed ${path.basename(dir)}/`)
      removed.push(`${path.basename(dir)}/`)
    }
    if (removed.length > 0) log.info(`restore: removed the leftovers of an earlier restore (${removed.join(', ')})`)
    if (abort) {
      log.warn('RESTORE_ABORT is set but no restore is staged; unset it (on Fly.io: fly secrets unset RESTORE_ABORT)')
    }
    return removed.length > 0 ? 'cleaned' : 'none'
  }

  if (abort) {
    let name = '(unknown backup)'
    try {
      name = readReady(readyFile).name
    } catch {
      // the marker's content does not matter for discarding
    }
    const rollBack = present(previous)
    if (rollBack) {
      // a swap is in progress: put the restored items back into the stage, the kept ones back in place
      for (const item of [UPLOADS, DB_FILE_NAME]) {
        // a swap only starts with both items staged, so a missing staged item is the one now live
        if (!present(inStage(item)) && present(live(item))) {
          move(live(item), inStage(item))
          step(`moved ${item} back into ${RESTORE_DIR}/`)
        }
        if (present(kept(item)) && !present(live(item))) {
          move(kept(item), live(item))
          step(`moved ${item} back from ${RESTORE_PREVIOUS_DIR}/`)
        }
      }
      for (const side of DB_SIDE_FILES) {
        if (present(kept(side)) && !present(live(side))) {
          move(kept(side), live(side))
          step(`moved ${side} back from ${RESTORE_PREVIOUS_DIR}/`)
        }
      }
      fs.rmdirSync(previous) // fails when anything is left, rather than deleting old data
      fsyncPath(dataDir)
      step(`removed ${RESTORE_PREVIOUS_DIR}/`)
    }
    fs.rmSync(readyFile)
    fsyncPath(staged)
    step(`removed ${RESTORE_DIR}/${RESTORE_READY_FILE}`)
    removeDir(staged, step)
    log.warn(
      `RESTORE_ABORT: discarded the staged restore of ${name}` +
        (rollBack ? ' after rolling back the swap in progress' : '') +
        '; the previous data stays live. Unset RESTORE_ABORT (on Fly.io: fly secrets unset RESTORE_ABORT)',
    )
    return 'discarded'
  }

  const ready = readReady(readyFile)
  if (!present(previous)) {
    // the swap has not started: it only starts on a complete stage
    const db = fs.statSync(inStage(DB_FILE_NAME), { throwIfNoEntry: false })
    if (!db?.isFile()) throw new Error(`${inStage(DB_FILE_NAME)} is missing`)
    if (db.size !== ready.notesDbSize) {
      throw new Error(`${inStage(DB_FILE_NAME)} is ${db.size} bytes, ${RESTORE_READY_FILE} says ${ready.notesDbSize}`)
    }
    if (!fs.statSync(inStage(UPLOADS), { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${inStage(UPLOADS)} is not a directory`)
    }
    fs.mkdirSync(previous)
    fsyncPath(dataDir)
    step(`created ${RESTORE_PREVIOUS_DIR}/`)
  }

  // the old database's WAL/SHM go with it: a restored database must never replay the old WAL
  const asideOf = (item: (typeof SWAP_ITEMS)[number]) => (item === DB_FILE_NAME ? [...DB_SIDE_FILES, item] : [item])
  // a kept copy next to a live one cannot come from an interrupted swap: refuse before changing anything
  for (const item of SWAP_ITEMS) {
    if (!present(inStage(item))) continue
    for (const old of asideOf(item)) {
      if (present(live(old)) && present(kept(old))) {
        throw new Error(`${kept(old)} already exists; refusing to overwrite it with ${live(old)}`)
      }
    }
  }
  for (const item of SWAP_ITEMS) {
    if (!present(inStage(item))) continue // already swapped in
    for (const old of asideOf(item)) {
      if (!present(live(old))) continue
      move(live(old), kept(old))
      step(`moved ${old} to ${RESTORE_PREVIOUS_DIR}/`)
    }
    move(inStage(item), live(item))
    step(`moved ${item} into place`)
  }

  fs.rmSync(readyFile)
  fsyncPath(staged)
  step(`removed ${RESTORE_DIR}/${RESTORE_READY_FILE}`)
  removeDir(staged, step)
  removeDir(previous, step)
  log.info(`restore: backup ${ready.name} is now the live data (${ready.uploadsCount} attachment files)`)
  return 'restored'
}
