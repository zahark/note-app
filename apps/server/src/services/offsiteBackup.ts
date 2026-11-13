// Off-site backups to an S3-compatible bucket (Cloudflare R2): one run makes the usual consistent snapshot
// (`runBackup`) in a temp directory on the machine's own filesystem (never the data volume), uploads
// `uploads.tar.gz`, then `notes.db`, then `manifest.json` last (its presence marks a backup complete), and
// removes the temp directory. Pruning lists the prefix and deletes old backups, but only ever runs after a
// successful upload (see `scheduleOffsiteBackup` in app.ts), always keeps the newest complete ones, and
// leaves keys it does not recognise alone. The state file `DATA_DIR/offsite-backup.json` records the last
// successful scheduled upload; only the scheduler writes it.
//
// Framework-free: the scheduler, its timers and its logging live in app.ts.
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { OffsiteBackupConfig } from '../config.js'
import { DB_FILE_NAME } from '../db/index.js'
import { DAY_MS } from '../units.js'
import { runBackup, UPLOADS_ARCHIVE_NAME } from './backup.js'
import { deleteObject, listObjects, putObjectFromFile } from './s3.js'

/** The object that marks a backup complete; uploaded last. */
export const MANIFEST_NAME = 'manifest.json'
/** State file in DATA_DIR recording the last successful scheduled upload. */
export const OFFSITE_STATE_FILE = 'offsite-backup.json'
/** Backup names as `runBackup` makes them; the only names ever used in (or pruned from) object keys. */
export const BACKUP_NAME_PATTERN = /^notes-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/
/** Complete backups always kept, however old (uploads may have been failing for a while). */
export const KEEP_NEWEST_BACKUPS = 7
/** An incomplete backup (no manifest) older than this is a failed upload and is deleted. */
export const INCOMPLETE_BACKUP_MAX_AGE_MS = DAY_MS

const BACKUP_FILES = [UPLOADS_ARCHIVE_NAME, DB_FILE_NAME, MANIFEST_NAME] as const
type BackupFileName = (typeof BACKUP_FILES)[number]

export interface FileDigest {
  size: number
  /** Lowercase hex SHA-256 of the file's bytes. */
  sha256: string
}

/** `manifest.json`, the last object of a backup. */
export interface OffsiteManifest {
  version: 1
  name: string
  /** ISO time of the snapshot. */
  createdAt: string
  files: { 'notes.db': FileDigest; 'uploads.tar.gz': FileDigest }
  /** Files in the tarball and the sum of their sizes (what a restore needs on disk for them). */
  uploads: { count: number; bytes: number }
  /** Storage names with an attachment row whose file was missing at backup time. */
  missing: string[]
}

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
 * Makes a snapshot of `dataDir` and uploads it as `<prefix><name>/{uploads.tar.gz,notes.db,manifest.json}`,
 * in that order, so a backup without its manifest is known to be incomplete. The temp directory is removed
 * on success and on failure. Never touches the state file and never prunes.
 */
export async function runOffsiteBackup(
  dataDir: string,
  cfg: OffsiteBackupConfig,
  { now = new Date(), tmpRoot = os.tmpdir(), signal }: RunOffsiteBackupOptions = {},
): Promise<OffsiteBackupResult> {
  signal?.throwIfAborted()
  const tmp = await fsp.mkdtemp(path.join(tmpRoot, 'notes-offsite-'))
  try {
    const backup = await runBackup({ dataDir, outDir: tmp, now })
    const name = path.basename(backup.dir)
    const files: OffsiteManifest['files'] = {
      'notes.db': await digestFile(backup.dbPath),
      'uploads.tar.gz': await digestFile(backup.archivePath),
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

    signal?.throwIfAborted()
    await putObjectFromFile(cfg, backupKey(cfg, name, UPLOADS_ARCHIVE_NAME), backup.archivePath, 'application/gzip', signal)
    await putObjectFromFile(cfg, backupKey(cfg, name, DB_FILE_NAME), backup.dbPath, 'application/vnd.sqlite3', signal)
    await putObjectFromFile(cfg, backupKey(cfg, name, MANIFEST_NAME), manifestPath, 'application/json', signal)
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
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  return Number.isNaN(date.getTime()) ? null : date
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

export interface PruneResult {
  /** Names of the backups whose objects were deleted. */
  deleted: string[]
}

/**
 * Deletes complete backups older than `keepDays` (by the time in their name) except the newest
 * `KEEP_NEWEST_BACKUPS` complete ones, and incomplete backups (no manifest) older than a day. Only keys of
 * the form `<prefix><backup name>/<backup file>` are ever deleted; a backup's manifest goes first, so an
 * interrupted prune leaves an incomplete backup that a later prune removes. A failed listing deletes nothing.
 */
export async function pruneOffsiteBackups(
  cfg: OffsiteBackupConfig,
  now: Date,
  signal?: AbortSignal,
): Promise<PruneResult> {
  const listed = await listObjects(cfg, cfg.prefix, signal)
  const backups = groupBackups(cfg, listed.map((o) => o.key))
  const complete = backups.filter((b) => b.complete).sort((a, b) => b.time.getTime() - a.time.getTime())
  const kept = new Set(complete.slice(0, KEEP_NEWEST_BACKUPS).map((b) => b.name))
  const keepMs = cfg.keepDays * DAY_MS
  const doomed = backups.filter((b) => {
    const age = now.getTime() - b.time.getTime()
    return b.complete ? !kept.has(b.name) && age > keepMs : age > INCOMPLETE_BACKUP_MAX_AGE_MS
  })

  const deleted: string[] = []
  for (const backup of doomed.sort((a, b) => a.time.getTime() - b.time.getTime())) {
    const isManifest = (key: string) => key.endsWith(`/${MANIFEST_NAME}`)
    const keys = [...backup.keys.filter(isManifest), ...backup.keys.filter((key) => !isManifest(key))]
    for (const key of keys) await deleteObject(cfg, key, signal)
    deleted.push(backup.name)
  }
  return { deleted }
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
