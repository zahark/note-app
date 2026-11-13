// `npm run restore:offsite -- <notes-backup-YYYYMMDD-HHMMSS>`: phase 1 of a restore from the off-site bucket,
// run while the app keeps running. Downloads the backup's manifest, checks there is room on the volume,
// downloads `notes.db` (size, SHA-256 and `integrity_check` verified) and streams `uploads.tar.gz` straight
// through SHA-256, gunzip and the safe tar reader into `restore-staging/uploads/` (the tarball never touches
// the disk). Only when everything checks out and is fsynced does it write `READY` and rename the stage to
// `restore/`, which the next start of the app swaps in (`services/restore.ts`). Any failure removes the
// stage; the live data is never touched. Reads only DATA_DIR and the BACKUP_* settings.
import { createHash, type Hash } from 'node:crypto'
import fs, { createWriteStream, existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline as pipelineCallback, Transform, type Readable, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type { OffsiteBackupConfig } from '../config.js'
import { DB_FILE_NAME } from '../db/index.js'
import { BackupError, readUploadsArchive, UPLOADS_ARCHIVE_NAME } from '../services/backup.js'
import {
  backupKey,
  backupNameTime,
  MANIFEST_NAME,
  type FileDigest,
  type OffsiteManifest,
} from '../services/offsiteBackup.js'
import {
  RESTORE_DIR,
  RESTORE_PREVIOUS_DIR,
  RESTORE_READY_FILE,
  RESTORE_STAGING_DIR,
  type RestoreReady,
} from '../services/restore.js'
import { getObjectStream, S3Error } from '../services/s3.js'
import { KIB, MIB } from '../units.js'
import { CliError, cliDataDir, cliOffsiteConfig, runIfInvokedDirectly, type OffsiteCliOptions } from './common.js'

const USAGE = 'Usage: npm run restore:offsite -- <notes-backup-YYYYMMDD-HHMMSS>'
const SETPRIV = 'setpriv --reuid=1000 --regid=1000 --clear-groups'
/** A manifest is a few hundred bytes; anything this large is not one. */
const MAX_MANIFEST_BYTES = 64 * KIB
/** Free space required on top of the restored files. */
const SPACE_MARGIN = 0.1

const digestSchema = z.object({
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
const manifestSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  createdAt: z.string(),
  files: z.object({ [DB_FILE_NAME]: digestSchema, [UPLOADS_ARCHIVE_NAME]: digestSchema }),
  uploads: z.object({
    count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  missing: z.array(z.string()),
})

type BackupFile = typeof DB_FILE_NAME | typeof UPLOADS_ARCHIVE_NAME

const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`

/** fsync of a file or directory, so a rename or a crash never exposes data still in the page cache. */
function fsyncPath(target: string): void {
  const fd = fs.openSync(target, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Downloads a small object whole, refusing anything over `max` bytes. */
async function downloadSmall(cfg: OffsiteBackupConfig, key: string, max: number, what: string): Promise<Buffer> {
  const { body, contentLength } = await getObjectStream(cfg, key)
  const tooLarge = () => new CliError(`${what} is larger than ${max} bytes; not a backup manifest`)
  if (contentLength !== null && contentLength > max) {
    body.destroy()
    throw tooLarge()
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > max) throw tooLarge() // leaving the loop destroys the body
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Fetches and validates `<name>/manifest.json`. */
async function fetchManifest(cfg: OffsiteBackupConfig, name: string): Promise<OffsiteManifest> {
  const raw = await downloadSmall(cfg, backupKey(cfg, name, MANIFEST_NAME), MAX_MANIFEST_BYTES, MANIFEST_NAME)
  let json: unknown
  try {
    json = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new CliError(`${MANIFEST_NAME} of ${name} is not valid JSON`)
  }
  const parsed = manifestSchema.safeParse(json)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new CliError(`${MANIFEST_NAME} of ${name} is not a valid backup manifest: ${problems}`)
  }
  if (parsed.data.name !== name) {
    throw new CliError(`${MANIFEST_NAME} of ${name} names another backup (${JSON.stringify(parsed.data.name)})`)
  }
  return parsed.data
}

/**
 * Passes a download through unchanged while hashing and counting it; fails the stream as soon as it grows
 * past the manifest's size, so a wrong object never fills the volume.
 */
class Verifier extends Transform {
  private readonly hash: Hash = createHash('sha256')
  private size = 0

  constructor(
    private readonly file: BackupFile,
    private readonly expected: FileDigest,
  ) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.size += chunk.length
    if (this.size > this.expected.size) {
      callback(new CliError(`${this.file} is larger than the ${this.expected.size} bytes in the manifest`))
      return
    }
    this.hash.update(chunk)
    callback(null, chunk)
  }

  /** After the whole download went through: its size and SHA-256 must be the manifest's. */
  check(): void {
    if (this.size !== this.expected.size) {
      throw new CliError(`${this.file} is ${this.size} bytes, the manifest says ${this.expected.size}`)
    }
    if (this.hash.digest('hex') !== this.expected.sha256) {
      throw new CliError(`${this.file} does not match the SHA-256 in the manifest`)
    }
  }
}

/** Starts a download and refuses it early when its `Content-Length` already disagrees with the manifest. */
async function openDownload(
  cfg: OffsiteBackupConfig,
  name: string,
  file: BackupFile,
  expected: FileDigest,
): Promise<{ body: Readable; verifier: Verifier }> {
  const { body, contentLength } = await getObjectStream(cfg, backupKey(cfg, name, file))
  if (contentLength !== null && contentLength !== expected.size) {
    body.destroy()
    throw new CliError(`${file} is ${contentLength} bytes, the manifest says ${expected.size}`)
  }
  return { body, verifier: new Verifier(file, expected) }
}

/** Downloads and verifies `notes.db` into the stage. */
async function stageDatabase(cfg: OffsiteBackupConfig, manifest: OffsiteManifest, dest: string): Promise<void> {
  const { body, verifier } = await openDownload(cfg, manifest.name, DB_FILE_NAME, manifest.files['notes.db'])
  await pipeline(body, verifier, createWriteStream(dest, { flags: 'wx' }))
  verifier.check()

  let check: unknown
  try {
    const db = new Database(dest, { readonly: true, fileMustExist: true })
    try {
      check = db.pragma('integrity_check', { simple: true })
    } finally {
      db.close()
    }
  } catch (err) {
    throw new CliError(`${DB_FILE_NAME} of ${manifest.name} is not a usable database: ${(err as Error).message}`)
  }
  if (check !== 'ok') {
    throw new CliError(`${DB_FILE_NAME} of ${manifest.name} failed its integrity check: ${String(check)}`)
  }
  fsyncPath(dest)
}

/** Streams `uploads.tar.gz` through the verifier and the tar reader into `<uploads>/<storage name>`. */
async function stageUploads(cfg: OffsiteBackupConfig, manifest: OffsiteManifest, uploads: string): Promise<void> {
  await fsp.mkdir(uploads)
  const { body, verifier } = await openDownload(cfg, manifest.name, UPLOADS_ARCHIVE_NAME, manifest.files['uploads.tar.gz'])
  // an error of either stream destroys both, and the reader rethrows it
  const source = pipelineCallback(body, verifier, () => {})
  const written: string[] = []
  try {
    const summary = await readUploadsArchive(source, async (entry, data) => {
      const file = path.join(uploads, entry.name)
      await pipeline(data, createWriteStream(file, { flags: 'wx' }))
      written.push(file)
    })
    verifier.check()
    if (summary.count !== manifest.uploads.count) {
      throw new CliError(
        `${UPLOADS_ARCHIVE_NAME} holds ${summary.count} files, the manifest's upload count is ${manifest.uploads.count}`,
      )
    }
    if (summary.bytes !== manifest.uploads.bytes) {
      throw new CliError(
        `${UPLOADS_ARCHIVE_NAME} holds ${summary.bytes} bytes of files, the manifest's upload bytes are ${manifest.uploads.bytes}`,
      )
    }
  } finally {
    body.destroy()
    verifier.destroy()
  }
  for (const file of written) fsyncPath(file)
  fsyncPath(uploads)
}

/** Refuses when the volume cannot hold the restored database and uploads (plus a margin) next to the live data. */
async function checkFreeSpace(dataDir: string, manifest: OffsiteManifest): Promise<void> {
  const { bavail, bsize } = await fsp.statfs(dataDir)
  const free = bavail * bsize
  const need = Math.ceil((manifest.files['notes.db'].size + manifest.uploads.bytes) * (1 + SPACE_MARGIN))
  if (free < need) {
    throw new CliError(
      `Not enough free space in ${dataDir}: restoring ${manifest.name} needs ${formatMib(need)} ` +
        `(with a ${SPACE_MARGIN * 100}% margin), ${formatMib(free)} is free. Extend the volume first ` +
        '(fly volumes extend <volume-id> --size <GB>); raise UPLOAD_QUOTA_MB only together with the volume.',
    )
  }
}

/** Downloads, verifies and stages the backup in `staging`, then publishes it as `restore`. */
async function stage(cfg: OffsiteBackupConfig, dataDir: string, name: string): Promise<OffsiteManifest> {
  const staging = path.join(dataDir, RESTORE_STAGING_DIR)
  const manifest = await fetchManifest(cfg, name)
  await checkFreeSpace(dataDir, manifest)

  await fsp.mkdir(staging)
  const dbPath = path.join(staging, DB_FILE_NAME)
  await stageDatabase(cfg, manifest, dbPath)
  const uploads = path.join(staging, 'uploads')
  await stageUploads(cfg, manifest, uploads)
  fsyncPath(staging)

  const ready: RestoreReady = { name, notesDbSize: manifest.files['notes.db'].size, uploadsCount: manifest.uploads.count }
  const readyPath = path.join(staging, RESTORE_READY_FILE)
  fs.writeFileSync(readyPath, `${JSON.stringify(ready)}\n`, { flag: 'wx' })
  fsyncPath(readyPath)
  fsyncPath(staging)
  fs.renameSync(staging, path.join(dataDir, RESTORE_DIR))
  fsyncPath(dataDir)
  return manifest
}

/** The CLI (exported for tests): expected failures are `CliError`s; any failure leaves no stage behind. */
export async function main(args: string[], options: OffsiteCliOptions = {}): Promise<void> {
  if (process.getuid?.() === 0) {
    throw new CliError(
      'Refusing to run as root: the restored files must belong to the app user (uid 1000). Run instead:\n' +
        `  ${SETPRIV} npm run restore:offsite -- <name>`,
    )
  }
  const [name, ...rest] = args
  if (name === undefined || rest.length > 0) throw new CliError(USAGE)
  if (backupNameTime(name) === null) {
    throw new CliError(`${JSON.stringify(name)} is not a backup name (notes-backup-YYYYMMDD-HHMMSS).\n${USAGE}`)
  }
  const cfg = cliOffsiteConfig(options)
  const dataDir = cliDataDir(options.env)
  if (!existsSync(dataDir)) throw new CliError(`DATA_DIR ${dataDir} does not exist`)

  const restoreDir = path.join(dataDir, RESTORE_DIR)
  if (existsSync(restoreDir)) {
    throw new CliError(
      `A restore is already staged in ${restoreDir} (or being applied). Restart the app to apply it, ` +
        'or start it once with RESTORE_ABORT=1 to discard it, before staging another one.',
    )
  }
  const staging = path.join(dataDir, RESTORE_STAGING_DIR)
  // leftovers: an interrupted earlier run, and (with no restore/) the end of a finished swap's cleanup
  await fsp.rm(staging, { recursive: true, force: true })
  await fsp.rm(path.join(dataDir, RESTORE_PREVIOUS_DIR), { recursive: true, force: true })

  let manifest: OffsiteManifest
  try {
    manifest = await stage(cfg, dataDir, name)
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true })
    if (err instanceof CliError) throw err
    if (err instanceof BackupError) throw new CliError(`${name}: ${err.message}`)
    if (err instanceof S3Error) throw new CliError(`${name}: download failed: ${err.message}`)
    throw err
  }

  if (manifest.missing.length > 0) {
    console.warn(`warning: ${manifest.missing.length} attachment files were already missing when ${name} was made`)
  }
  console.log(
    `Backup ${name} is verified and staged in ${restoreDir} ` +
      `(${DB_FILE_NAME} ${manifest.files['notes.db'].size} bytes, ${manifest.uploads.count} attachment files).\n` +
      'Restart the app to apply it (on Fly.io: fly machine restart). ' +
      'To discard it instead, start the app once with RESTORE_ABORT=1.',
  )
}

runIfInvokedDirectly(import.meta.url, (args) => main(args))
