// `npm run backup`: an online, consistent copy of the database plus a tarball of the referenced uploads,
// taken while the live database stays open (and has un-checkpointed WAL content).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main as backupMain } from '../src/cli/backup.js'
import { CliError } from '../src/cli/common.js'
import { DB_FILE_NAME, openDataDb, type Db } from '../src/db/index.js'
import { storeUpload, uploadsDir } from '../src/services/attachments.js'
import { BackupError, runBackup, UPLOADS_ARCHIVE_NAME } from '../src/services/backup.js'
import { PNG, tmpDataDir } from './helpers/api.js'
import { seedUser } from './helpers/auth.js'

const NOW = new Date('2026-11-12T08:05:09.000Z')

let dataDir: string
let db: Db
let userId: string

beforeEach(() => {
  dataDir = tmpDataDir()
  db = openDataDb(dataDir)
  db.pragma('wal_autocheckpoint = 0') // keep the writes below in the WAL, not the main file
  userId = seedUser(db, 'alice@example.com')
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

const upload = (data: Buffer = PNG) =>
  storeUpload(db, dataDir, userId, { originalName: 'cat.png', data })

/** Lists a gzipped tarball with the system `tar`, so the archive format is checked by an independent reader. */
const tarList = (archive: string): string[] =>
  execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()

describe('runBackup', () => {
  it('writes an openable, consistent database copy and a tarball of the referenced uploads', async () => {
    const a = await upload()
    const big = Buffer.concat([PNG, Buffer.alloc(70_000, 7)]) // spans many tar blocks, not block-aligned
    const b = await upload(big)
    // a stray file (no row) is not part of the snapshot
    writeFileSync(path.join(uploadsDir(dataDir), 'stray'), 'x')
    expect(existsSync(path.join(dataDir, `${DB_FILE_NAME}-wal`))).toBe(true)

    const result = await runBackup({ dataDir, now: NOW })

    expect(result.dir).toBe(path.join(dataDir, 'backups', 'notes-backup-20261112-080509'))
    expect(readdirSync(result.dir).sort()).toEqual([DB_FILE_NAME, UPLOADS_ARCHIVE_NAME])
    expect(result.files).toBe(2)
    expect(result.uploadBytes).toBe(PNG.length + big.length)
    expect(result.missing).toEqual([])
    // no leftover work directory
    expect(readdirSync(path.join(dataDir, 'backups'))).toEqual(['notes-backup-20261112-080509'])

    const copy = new Database(result.dbPath, { readonly: true, fileMustExist: true })
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(copy.pragma('journal_mode', { simple: true })).toBe('delete')
      expect(copy.prepare('SELECT email FROM users').pluck().all()).toEqual(['alice@example.com'])
      expect(copy.prepare('SELECT storage_name FROM attachments ORDER BY storage_name').pluck().all()).toEqual(
        [a.storage_name, b.storage_name].sort(),
      )
      // migrations were copied as-is, not re-run
      expect(copy.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(
        db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(),
      )
    } finally {
      copy.close()
    }

    expect(tarList(result.archivePath)).toEqual([`uploads/${a.storage_name}`, `uploads/${b.storage_name}`].sort())
    const restore = path.join(dataDir, 'restore')
    mkdirSync(restore)
    execFileSync('tar', ['-xzf', result.archivePath, '-C', restore])
    expect(readFileSync(path.join(restore, 'uploads', a.storage_name))).toEqual(PNG)
    expect(readFileSync(path.join(restore, 'uploads', b.storage_name))).toEqual(big)
  })

  it('writes into outDir and skips (and reports) attachment rows whose file is missing', async () => {
    const kept = await upload()
    const lost = await upload()
    rmSync(path.join(uploadsDir(dataDir), lost.storage_name))
    const outDir = path.join(dataDir, 'elsewhere')

    const result = await runBackup({ dataDir, outDir, now: NOW })

    expect(path.dirname(result.dir)).toBe(outDir)
    expect(result.files).toBe(1)
    expect(result.uploadBytes).toBe(PNG.length) // the missing file counts for nothing
    expect(result.missing).toEqual([lost.storage_name])
    expect(tarList(result.archivePath)).toEqual([`uploads/${kept.storage_name}`])
  })

  it('produces a valid, empty tarball when there are no uploads', async () => {
    const result = await runBackup({ dataDir, now: NOW })
    expect(result.files).toBe(0)
    expect(result.uploadBytes).toBe(0)
    expect(tarList(result.archivePath)).toEqual([])
  })

  it('refuses to run without a database and never overwrites an existing backup', async () => {
    const empty = tmpDataDir()
    try {
      await expect(runBackup({ dataDir: empty, now: NOW })).rejects.toThrow(BackupError)
      expect(existsSync(path.join(empty, 'backups'))).toBe(false)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }

    await runBackup({ dataDir, now: NOW })
    await expect(runBackup({ dataDir, now: NOW })).rejects.toThrow(/already exists/)
    expect(readdirSync(path.join(dataDir, 'backups'))).toEqual(['notes-backup-20261112-080509'])
  })
})

describe('backup CLI', () => {
  it('reports a BackupError as a CliError with the same message', async () => {
    const empty = tmpDataDir()
    try {
      const err = await backupMain([], { env: { DATA_DIR: empty } }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(CliError)
      expect((err as Error).message).toBe(`No database at ${path.join(empty, DB_FILE_NAME)} (check DATA_DIR)`)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('refuses extra arguments with its usage line', async () => {
    const empty = tmpDataDir()
    try {
      const err = await backupMain(['a', 'b'], { env: { DATA_DIR: empty } }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(CliError)
      expect((err as Error).message).toMatch(/^Usage: npm run backup/)
      expect(readdirSync(empty)).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
