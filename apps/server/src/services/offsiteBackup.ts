// Off-site backups to an S3-compatible bucket (Cloudflare R2): one run makes the usual consistent snapshot
// (`runBackup`) in a temp directory on the machine's own filesystem (never the data volume), uploads
// `uploads.tar.gz`, then `notes.db`, then `manifest.json` last (its presence marks a backup complete), and
// removes the temp directory. Pruning lists the prefix and deletes old backups, but only ever runs after a
// successful upload (see `scheduleOffsiteBackup` in app.ts), always keeps the newest complete ones, and
// leaves keys it does not recognise alone. The state file `DATA_DIR/offsite-backup.json` records the last
// successful scheduled upload; only the scheduler writes it. The scheduler skips a database that holds no
// notes, folders or attachments yet (`holdsUserData` in repos/publicShare.ts), so a fresh installation
// never fills the bucket with empty backups that would push real ones out of the always-kept newest 7.
//
// Framework-free: the scheduler, its timers and its logging live in app.ts.
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import type { OffsiteBackupConfig } from '../config.js'
import { DB_FILE_NAME } from '../db/index.js'
import { DAY_MS, HOUR_MS } from '../units.js'
import { BACKUP_NAME_PATTERN, runBackup, UPLOADS_ARCHIVE_NAME } from './backup.js'
import { deleteObject, listObjects, putObjectFromFile } from './s3.js'

/** The object that marks a backup complete; uploaded last. */
export const MANIFEST_NAME = 'manifest.json'
/** State file in DATA_DIR recording the last successful scheduled upload. */
export const OFFSITE_STATE_FILE = 'offsite-backup.json'
/** Complete backups always kept, however old (uploads may have been failing for a while). */
export const KEEP_NEWEST_BACKUPS = 7
/** An incomplete backup (no manifest) older than this is a failed upload and is deleted. */
export const INCOMPLETE_BACKUP_MAX_AGE_MS = DAY_MS
/** Prefix of the temp directory one run makes in `os.tmpdir()`. */
export const OFFSITE_TEMP_PREFIX = 'notes-offsite-'
/** A temp directory left this long is from a run that was killed (SIGKILL skips its cleanup). */
export const STALE_TEMP_DIR_AGE_MS = HOUR_MS

const BACKUP_FILES = [UPLOADS_ARCHIVE_NAME, DB_FILE_NAME, MANIFEST_NAME] as const
/** The objects of one backup (backup names are `BACKUP_NAME_PATTERN`, the only ones used in object keys). */
export type BackupFileName = (typeof BACKUP_FILES)[number]

const byteCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

const fileDigestSchema = z.object({
  size: byteCount,
  /** Lowercase hex SHA-256 of the file's bytes. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export type FileDigest = z.infer<typeof fileDigestSchema>

/** `manifest.json`, the last object of a backup; `restore:offsite` validates a downloaded one with it. */
export const offsiteManifestSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  /** ISO time of the snapshot. */
  createdAt: z.string(),
  files: z.object({ [DB_FILE_NAME]: fileDigestSchema, [UPLOADS_ARCHIVE_NAME]: fileDigestSchema }),
  /** Files in the tarball and the sum of their sizes (what a restore needs on disk for them). */
  uploads: z.object({ count: byteCount, bytes: byteCount }),
  /** Storage names with an attachment row whose file was missing at backup time. */
  missing: z.array(z.string()),
})
export type OffsiteManifest = z.infer<typeof offsiteManifestSchema>

export interface OffsiteBackupResult {
  name: string
  files: OffsiteManifest['files']
}

export interface RunOffsiteBackupOptions {
  /** Snapshot time, used for the backup name (default: now). */
  now?: Date
  /** Where the temp directory is made (default `os.tmpdir()`; never the data volume). */
  tmpRoot?: string
  /** Aborts an upload in flight (the server's `app.close()`). */
  signal?: AbortSignal
}

/** `<prefix><name>/<file>`. */
export function backupKey(cfg: OffsiteBackupConfig, name: string, file: BackupFileName): string {
  return `${cfg.prefix}${name}/${file}`
}

/** What log lines may say about the target: endpoint host, bucket and prefix (never the keys). */
export function offsiteBackupTarget(cfg: OffsiteBackupConfig): { endpoint: string; bucket: string; prefix: string } {
  return { endpoint: cfg.endpoint.host, bucket: cfg.bucket, prefix: cfg.prefix }
}

/** Whether `key` is a backup's `manifest.json`. */
const isManifestKey = (key: string): boolean => key.endsWith(`/${MANIFEST_NAME}`)

/** A backup's keys, manifest first: deleted in this order, no "complete" backup is ever left without data. */
function manifestFirst(keys: string[]): string[] {
  return [...keys.filter(isManifestKey), ...keys.filter((key) => !isManifestKey(key))]
}

async function digestFile(file: string): Promise<FileDigest> {
  const hash = createHash('sha256')
  let size = 0
  await pipeline(createReadStream(file), async (source: AsyncIterable<Buffer>) => {
    for await (const chunk of source) {
      size += chunk.length
      hash.update(chunk)
    }
  })
  return { size, sha256: hash.digest('hex') }
}

/**
 * Removes `notes-offsite-*` temp directories in `tmpRoot` older than `STALE_TEMP_DIR_AGE_MS`: left by a run
 * that was killed before its cleanup (a container restart keeps `/tmp`). Best effort; returns the names
 * removed.
 */
export function sweepStaleOffsiteTempDirs(tmpRoot: string = os.tmpdir(), nowMs: number = Date.now()): string[] {
  const removed: string[] = []
  let names: string[]
  try {
    names = readdirSync(tmpRoot)
  } catch {
    return removed
  }
  for (const name of names) {
    if (!name.startsWith(OFFSITE_TEMP_PREFIX)) continue
    const dir = path.join(tmpRoot, name)
    try {
      const stats = statSync(dir)
      if (!stats.isDirectory() || nowMs - stats.mtimeMs < STALE_TEMP_DIR_AGE_MS) continue
      rmSync(dir, { recursive: true, force: true })
      removed.push(name)
    } catch {
      // gone already, or not ours to remove
    }
  }
  return removed
}

/**
 * Deletes the objects of a failed run, best effort, the manifest first (like a prune): its PUT may have been
 * stored although it reported a failure, and a manifest left next to deleted data would be a "complete"
 * backup that cannot be restored and that takes one of the always-kept newest slots. When deleting the
 * manifest fails, the data stays too (the backup is then either complete or one a later prune removes);
 * 404 counts as deleted.
 */
async function deleteAttempted(cfg: OffsiteBackupConfig, keys: string[]): Promise<void> {
  for (const key of manifestFirst(keys)) {
    if (isManifestKey(key)) {
      try {
        await deleteObject(cfg, key)
      } catch {
        return
      }
    } else {
      await deleteObject(cfg, key).catch(() => {})
    }
  }
}

/**
 * Makes a snapshot of `dataDir` and uploads it as `<prefix><name>/{uploads.tar.gz,notes.db,manifest.json}`,
 * in that order, so a backup without its manifest is known to be incomplete. The temp directory is removed
 * on success and on failure. When an upload fails (not on abort), every object this run tried to upload is
 * deleted again (best effort; see `deleteAttempted`), so hourly retries of a failing run do not pile up
 * full-size tarballs. Never touches the state file and never prunes.
 */
export async function runOffsiteBackup(
  dataDir: string,
  cfg: OffsiteBackupConfig,
  { now = new Date(), tmpRoot = os.tmpdir(), signal }: RunOffsiteBackupOptions = {},
): Promise<OffsiteBackupResult> {
  signal?.throwIfAborted()
  const tmp = await fsp.mkdtemp(path.join(tmpRoot, OFFSITE_TEMP_PREFIX))
  // every key whose PUT started: a PUT that failed on our side (a timeout or a reset before the answer, a
  // 5xx after the write) may still have stored the object
  const attempted: string[] = []
  try {
    const backup = await runBackup({ dataDir, outDir: tmp, now })
    const name = path.basename(backup.dir)
    const files: OffsiteManifest['files'] = {
      [DB_FILE_NAME]: await digestFile(backup.dbPath),
      [UPLOADS_ARCHIVE_NAME]: await digestFile(backup.archivePath),
    }
    const manifest: OffsiteManifest = {
      version: 1,
      name,
      createdAt: now.toISOString(),
      files,
      uploads: { count: backup.files, bytes: backup.uploadBytes },
      missing: backup.missing,
    }
    const manifestPath = path.join(tmp, MANIFEST_NAME)
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const uploads: Array<[BackupFileName, string, string]> = [
      [UPLOADS_ARCHIVE_NAME, backup.archivePath, 'application/gzip'],
      [DB_FILE_NAME, backup.dbPath, 'application/vnd.sqlite3'],
      [MANIFEST_NAME, manifestPath, 'application/json'],
    ]
    try {
      for (const [file, filePath, contentType] of uploads) {
        signal?.throwIfAborted()
        const key = backupKey(cfg, name, file)
        attempted.push(key)
        await putObjectFromFile(cfg, key, filePath, contentType, signal)
      }
    } catch (err) {
      // on shutdown there is no time for this; the next successful run's prune removes the rest after a day
      if (!signal?.aborted) await deleteAttempted(cfg, attempted)
      throw err
    }
    return { name, files }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
}

/** The snapshot time encoded in a backup name (UTC), or `null` for any other name. */
export function backupNameTime(name: string): Date | null {
  const m = BACKUP_NAME_PATTERN.exec(name)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s))
}

interface ListedBackup {
  name: string
  time: Date
  complete: boolean
  keys: string[]
}

/** Groups the listed keys `<prefix><name>/<known file>` by backup; every other key is ignored. */
function groupBackups(cfg: OffsiteBackupConfig, keys: string[]): ListedBackup[] {
  const backups = new Map<string, ListedBackup>()
  for (const key of keys) {
    if (!key.startsWith(cfg.prefix)) continue
    const parts = key.slice(cfg.prefix.length).split('/')
    if (parts.length !== 2) continue
    const [name = '', file = ''] = parts
    const time = backupNameTime(name)
    if (time === null || !(BACKUP_FILES as readonly string[]).includes(file)) continue
    let backup = backups.get(name)
    if (!backup) {
      backup = { name, time, complete: false, keys: [] }
      backups.set(name, backup)
    }
    if (file === MANIFEST_NAME) backup.complete = true
    backup.keys.push(key)
  }
  return [...backups.values()]
}

/**
 * Deletes complete backups older than `keepDays` (by the time in their name) except the newest
 * `KEEP_NEWEST_BACKUPS` complete ones, and incomplete backups (no manifest) older than a day. Only keys of
 * the form `<prefix><backup name>/<backup file>` are ever deleted; a backup's manifest goes first, so an
 * interrupted prune leaves an incomplete backup that a later prune removes. A failed listing deletes nothing.
 * Returns the names of the backups deleted.
 */
export async function pruneOffsiteBackups(
  cfg: OffsiteBackupConfig,
  now: Date,
  signal?: AbortSignal,
): Promise<string[]> {
  const backups = groupBackups(cfg, await listObjects(cfg, cfg.prefix, signal))
  const complete = backups.filter((b) => b.complete).sort((a, b) => b.time.getTime() - a.time.getTime())
  const kept = new Set(complete.slice(0, KEEP_NEWEST_BACKUPS).map((b) => b.name))
  const keepMs = cfg.keepDays * DAY_MS
  const doomed = backups.filter((b) => {
    const age = now.getTime() - b.time.getTime()
    return b.complete ? !kept.has(b.name) && age > keepMs : age > INCOMPLETE_BACKUP_MAX_AGE_MS
  })

  const deleted: string[] = []
  for (const backup of doomed.sort((a, b) => a.time.getTime() - b.time.getTime())) {
    for (const key of manifestFirst(backup.keys)) await deleteObject(cfg, key, signal)
    deleted.push(backup.name)
  }
  return deleted
}

/** `DATA_DIR/offsite-backup.json`. */
export interface OffsiteState {
  /** ISO time of the last successful scheduled backup's snapshot. */
  lastSuccessAt: string
  lastBackup: string
}

function statePath(dataDir: string): string {
  return path.join(dataDir, OFFSITE_STATE_FILE)
}

/** The state file, or `null` when it is missing, unreadable or malformed (all mean "back up now"). */
export function readOffsiteState(dataDir: string): OffsiteState | null {
  try {
    const value = JSON.parse(readFileSync(statePath(dataDir), 'utf8')) as Partial<OffsiteState> | null
    if (typeof value?.lastSuccessAt !== 'string' || typeof value.lastBackup !== 'string') return null
    if (Number.isNaN(new Date(value.lastSuccessAt).getTime())) return null
    return { lastSuccessAt: value.lastSuccessAt, lastBackup: value.lastBackup }
  } catch {
    return null
  }
}

/** Writes the state file atomically (temp file + rename), so a crash never leaves half a file. */
export function writeOffsiteState(dataDir: string, state: OffsiteState): void {
  const file = statePath(dataDir)
  const tmp = `${file}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(state)}\n`)
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * True when a backup is due: no usable state, or the last success is at least `intervalMs` old. A last
 * success in the future (a clock that jumped back) also counts as due, so backups never stop silently.
 */
export function isOffsiteBackupDue(state: OffsiteState | null, intervalMs: number, nowMs: number): boolean {
  if (state === null) return true
  const age = nowMs - new Date(state.lastSuccessAt).getTime()
  return age < 0 || age >= intervalMs
}
