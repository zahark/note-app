// `npm run restore:offsite -- <name>`: downloads a backup from the fake S3 server (made by `runOffsiteBackup`
// from a seeded data dir, never real R2), verifies it and stages it in DATA_DIR/restore/ while the live data
// (an open database with WAL content, and its uploads) stays untouched. Any failure leaves no stage behind.
import { createHash } from 'node:crypto'
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../src/cli/common.js'
import { main as restoreOffsiteMain } from '../src/cli/restoreOffsite.js'
import { DB_FILE_NAME, openDataDb, type Db } from '../src/db/index.js'
import { storeUpload, uploadsDir } from '../src/services/attachments.js'
import { MANIFEST_NAME, runOffsiteBackup, type OffsiteManifest } from '../src/services/offsiteBackup.js'
import { PNG, tmpDataDir } from './helpers/api.js'
import { seedUser } from './helpers/auth.js'
import { FAKE_S3_BUCKET, FakeS3 } from './helpers/fakeS3.js'

const NOW = new Date('2026-11-13T09:30:15.000Z')
const NAME = 'notes-backup-20261113-093015'
const EMPTY_NAME = 'notes-backup-20261114-093015'
const PREFIX = 'notes-backups/'
const BIG = Buffer.concat([PNG, Buffer.alloc(70_000, 7)])

let sourceDir: string
let dataDir: string
let liveDb: Db
let fake: FakeS3
/** The backup's files as the source data dir had them: storage name → bytes. */
let backupFiles: Map<string, Buffer>
let log: string[]

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const key = (name: string, file: string) => `${PREFIX}${name}/${file}`
const staging = () => path.join(dataDir, 'restore-staging')
const restore = () => path.join(dataDir, 'restore')

function restoreEnv(): NodeJS.ProcessEnv {
  return {
    DATA_DIR: dataDir,
    BACKUP_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    BACKUP_S3_BUCKET: FAKE_S3_BUCKET,
    BACKUP_S3_ACCESS_KEY_ID: 'AKIDFAKEKEY',
    BACKUP_S3_SECRET_ACCESS_KEY: 'fake-secret-access-key-value',
  }
}

const run = (args: string[]) => restoreOffsiteMain(args, { env: restoreEnv(), endpoint: fake.endpoint })

/** Runs the CLI and returns its CliError (fails the test when it succeeds or throws anything else). */
async function runFailing(args: string[]): Promise<CliError> {
  const err = await run(args).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(CliError)
  return err as CliError
}

beforeEach(async () => {
  fake = await new FakeS3().start()

  // the backup: alice with two uploads, plus an empty account in a second, attachment-free backup
  sourceDir = tmpDataDir()
  const source = openDataDb(sourceDir)
  const alice = seedUser(source, 'alice@example.com')
  const a = await storeUpload(source, sourceDir, alice, { originalName: 'a.png', data: PNG })
  const b = await storeUpload(source, sourceDir, alice, { originalName: 'b.png', data: BIG })
  backupFiles = new Map([
    [a.storage_name, PNG],
    [b.storage_name, BIG],
  ])
  await runOffsiteBackup(sourceDir, fake.config(), { now: NOW })
  source.prepare('DELETE FROM attachments').run()
  await runOffsiteBackup(sourceDir, fake.config(), { now: new Date('2026-11-14T09:30:15.000Z') })
  source.close()

  // the live data: bob with one upload, the database open (as the running app has it) with WAL content
  dataDir = tmpDataDir()
  liveDb = openDataDb(dataDir)
  liveDb.pragma('wal_autocheckpoint = 0')
  const bob = seedUser(liveDb, 'bob@example.com')
  await storeUpload(liveDb, dataDir, bob, { originalName: 'live.png', data: PNG })
  fake.requests.length = 0

  log = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    log.push(args.join(' '))
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  liveDb.close()
  await fake.stop()
  rmSync(sourceDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

/** Hashes of the live database, its WAL and every live upload. */
function liveSnapshot() {
  const file = (name: string) => sha256(readFileSync(path.join(dataDir, name)))
  const uploads = uploadsDir(dataDir)
  return {
    db: file(DB_FILE_NAME),
    wal: file(`${DB_FILE_NAME}-wal`),
    uploads: readdirSync(uploads)
      .sort()
      .map((name) => [name, sha256(readFileSync(path.join(uploads, name)))]),
  }
}

function manifestOf(name = NAME): OffsiteManifest {
  return JSON.parse(fake.objects.get(key(name, MANIFEST_NAME))!.body.toString('utf8')) as OffsiteManifest
}

function setManifest(change: (m: OffsiteManifest) => void, name = NAME): void {
  const manifest = manifestOf(name)
  change(manifest)
  fake.put(key(name, MANIFEST_NAME), JSON.stringify(manifest))
}

/** Replaces a backup file and records its new size and SHA-256 in the manifest (so only the content is bad). */
function replaceFile(file: 'notes.db' | 'uploads.tar.gz', body: Buffer, uploads?: { count: number; bytes: number }): void {
  fake.put(key(NAME, file), body)
  setManifest((m) => {
    m.files[file] = { size: body.length, sha256: sha256(body) }
    if (uploads) m.uploads = uploads
  })
}

/** One hand-built ustar entry (independent of the code under test). */
function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512)
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0')
  header.write(name, 0, 100, 'utf8')
  header.write(octal(0o600, 8), 100, 8, 'ascii')
  header.write(octal(0, 8), 108, 8, 'ascii')
  header.write(octal(0, 8), 116, 8, 'ascii')
  header.write(octal(data.length, 12), 124, 12, 'ascii')
  header.write(octal(0, 12), 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write('0', 156, 1, 'ascii')
  header.write('ustar\u0000', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${octal(sum, 7)}\u0000 `, 148, 8, 'ascii')
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512)
  return Buffer.concat([header, data, pad])
}

/** The backup's database with one b-tree page overwritten, so `integrity_check` fails. */
function corruptDatabase(): Buffer {
  const db = Buffer.from(fake.objects.get(key(NAME, DB_FILE_NAME))!.body)
  const pageSize = db.readUInt16BE(16)
  const pages = db.length / pageSize
  expect(pages).toBeGreaterThan(3)
  // every page after the first is overwritten with an invalid b-tree header
  for (let page = 1; page < pages; page++) db.fill(0xff, page * pageSize + 1, page * pageSize + 12)
  return db
}

describe('restore:offsite CLI: success', () => {
  it('stages the verified database and exactly the backup uploads in restore/, with READY last', async () => {
    const before = liveSnapshot()

    await run([NAME])

    expect(readdirSync(restore()).sort()).toEqual(['READY', DB_FILE_NAME, 'uploads'])
    expect(existsSync(staging())).toBe(false)
    const backupDb = fake.objects.get(key(NAME, DB_FILE_NAME))!.body
    expect(readFileSync(path.join(restore(), DB_FILE_NAME))).toEqual(backupDb)
    expect(JSON.parse(readFileSync(path.join(restore(), 'READY'), 'utf8'))).toEqual({
      name: NAME,
      notesDbSize: backupDb.length,
      uploadsCount: 2,
    })
    const staged = readdirSync(path.join(restore(), 'uploads')).sort()
    expect(staged).toEqual([...backupFiles.keys()].sort())
    for (const [name, data] of backupFiles) expect(readFileSync(path.join(restore(), 'uploads', name))).toEqual(data)

    // the staged database is the backup's: alice, not the live bob
    const copy = new Database(path.join(restore(), DB_FILE_NAME), { readonly: true, fileMustExist: true })
    expect(copy.prepare('SELECT email FROM users').pluck().all()).toEqual(['alice@example.com'])
    copy.close()

    // no tarball anywhere in DATA_DIR, live data untouched
    const all = fs.readdirSync(dataDir, { recursive: true }).map(String)
    expect(all.filter((p) => p.endsWith('.tar.gz'))).toEqual([])
    expect(liveSnapshot()).toEqual(before)
    // downloaded only what it needed
    expect(fake.requests.map((r) => `${r.method} ${r.key}`)).toEqual([
      `GET ${key(NAME, MANIFEST_NAME)}`,
      `GET ${key(NAME, DB_FILE_NAME)}`,
      `GET ${key(NAME, 'uploads.tar.gz')}`,
    ])
    expect(log.join('\n')).toMatch(/restart/i)
  })

  it('stages an empty uploads/ directory for a backup without attachments', async () => {
    await run([EMPTY_NAME])

    expect(readdirSync(path.join(restore(), 'uploads'))).toEqual([])
    expect(JSON.parse(readFileSync(path.join(restore(), 'READY'), 'utf8'))).toMatchObject({
      name: EMPTY_NAME,
      uploadsCount: 0,
    })
  })

  it('removes a leftover restore-staging/ and restore-previous/ before staging', async () => {
    mkdirSync(path.join(staging(), 'uploads'), { recursive: true })
    writeFileSync(path.join(staging(), 'uploads', 'leftover'), 'x')
    writeFileSync(path.join(staging(), 'READY'), '{}')
    mkdirSync(path.join(dataDir, 'restore-previous'))
    writeFileSync(path.join(dataDir, 'restore-previous', DB_FILE_NAME), 'old')

    await run([NAME])

    expect(existsSync(staging())).toBe(false)
    expect(existsSync(path.join(dataDir, 'restore-previous'))).toBe(false)
    expect(readdirSync(path.join(restore(), 'uploads')).sort()).toEqual([...backupFiles.keys()].sort())
  })

  it('fsyncs every staged file and directory before writing READY, then READY and DATA_DIR', async () => {
    const opened = new Map<number, string>()
    const synced: { file: string; ready: boolean }[] = []
    const openSync = fs.openSync.bind(fs)
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = openSync(...args)
      opened.set(fd, String(args[0]))
      return fd
    })
    const fsyncSync = fs.fsyncSync.bind(fs)
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
      const ready = existsSync(path.join(staging(), 'READY')) || existsSync(path.join(restore(), 'READY'))
      synced.push({ file: opened.get(fd) ?? `fd ${fd}`, ready })
      fsyncSync(fd)
    })

    await run([NAME])

    const before = synced.filter((s) => !s.ready).map((s) => s.file)
    const after = synced.filter((s) => s.ready).map((s) => s.file)
    expect(before).toEqual(
      expect.arrayContaining([
        path.join(staging(), DB_FILE_NAME),
        ...[...backupFiles.keys()].map((name) => path.join(staging(), 'uploads', name)),
        path.join(staging(), 'uploads'),
        staging(),
      ]),
    )
    expect(after).toEqual([path.join(staging(), 'READY'), staging(), dataDir])
  })
})

describe('restore:offsite CLI: refusals', () => {
  it('refuses to run as root and names the setpriv command', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    const err = await runFailing([NAME])
    expect(err.message).toContain('setpriv --reuid=1000 --regid=1000 --clear-groups')
    expect(fake.requests).toEqual([])
    expect(existsSync(restore())).toBe(false)
  })

  it.each([
    ['no name', []],
    ['two names', [NAME, EMPTY_NAME]],
    ['a malformed name', ['notes-backup-2026']],
    ['a path', [`../${NAME}`]],
    ['a name with a suffix', [`${NAME}/x`]],
  ])('rejects %s before any request', async (_label, args) => {
    const err = await runFailing(args)
    expect(err.message).toMatch(/Usage: npm run restore:offsite|backup name/)
    expect(fake.requests).toEqual([])
  })

  it('refuses when a restore is already staged and leaves it alone', async () => {
    mkdirSync(path.join(restore(), 'uploads'), { recursive: true })
    writeFileSync(path.join(restore(), 'READY'), '{"name":"other"}')

    const err = await runFailing([NAME])

    expect(err.message).toMatch(/already staged/)
    expect(err.message).toContain('RESTORE_ABORT')
    expect(readFileSync(path.join(restore(), 'READY'), 'utf8')).toBe('{"name":"other"}')
    expect(fake.requests).toEqual([])
  })

  it('refuses with the extend-the-volume message when free space is short', async () => {
    const before = liveSnapshot()
    vi.spyOn(fsp, 'statfs').mockResolvedValue({ bavail: 10, bsize: 4096 } as Awaited<ReturnType<typeof fsp.statfs>>)

    const err = await runFailing([NAME])

    expect(err.message).toContain('fly volumes extend')
    expect(err.message).toContain('UPLOAD_QUOTA_MB')
    expect(fake.requests.map((r) => r.key)).toEqual([key(NAME, MANIFEST_NAME)])
    expect(existsSync(staging())).toBe(false)
    expect(existsSync(restore())).toBe(false)
    expect(liveSnapshot()).toEqual(before)
  })

  it('refuses when the backup has no manifest (incomplete or unknown)', async () => {
    const err = await runFailing(['notes-backup-20200101-000000'])
    expect(err.message).toContain('NoSuchKey')
    expect(existsSync(staging())).toBe(false)
  })

  it.each([
    ['another name', (m: OffsiteManifest) => (m.name = EMPTY_NAME)],
    ['another version', (m: OffsiteManifest) => ((m as { version: number }).version = 2)],
    ['a bad digest', (m: OffsiteManifest) => (m.files['notes.db'].sha256 = 'zz')],
    ['a negative size', (m: OffsiteManifest) => (m.files['uploads.tar.gz'].size = -1)],
  ])('refuses a manifest with %s', async (_label, change) => {
    setManifest(change)
    const err = await runFailing([NAME])
    expect(err.message).toMatch(/manifest/i)
    expect(fake.requests).toHaveLength(1)
  })

  it('refuses an oversized manifest', async () => {
    fake.put(key(NAME, MANIFEST_NAME), Buffer.alloc(65 * 1024, 0x20))
    const err = await runFailing([NAME])
    expect(err.message).toMatch(/manifest/i)
  })
})

describe('restore:offsite CLI: a bad download stages nothing and leaves the live data alone', () => {
  const flipByte = (data: Buffer, at: number) => {
    const copy = Buffer.from(data)
    copy[at] = copy[at]! ^ 0xff
    return copy
  }
  const body = (file: string) => fake.objects.get(key(NAME, file))!.body

  it.each([
    ['notes.db size mismatch', () => fake.put(key(NAME, DB_FILE_NAME), Buffer.concat([body(DB_FILE_NAME), Buffer.from('x')])), /notes\.db/],
    ['notes.db SHA-256 mismatch', () => fake.put(key(NAME, DB_FILE_NAME), flipByte(body(DB_FILE_NAME), 200)), /notes\.db.*SHA-256/],
    ['notes.db failing integrity_check', () => replaceFile('notes.db', corruptDatabase()), /notes\.db/],
    [
      'uploads.tar.gz size mismatch',
      () => fake.put(key(NAME, 'uploads.tar.gz'), Buffer.concat([body('uploads.tar.gz'), Buffer.alloc(10)])),
      /uploads\.tar\.gz|archive/,
    ],
    // the gzip header's mtime field: still valid gzip, different bytes
    ['uploads.tar.gz SHA-256 mismatch', () => fake.put(key(NAME, 'uploads.tar.gz'), flipByte(body('uploads.tar.gz'), 5)), /uploads\.tar\.gz.*SHA-256/],
    [
      'an unsafe tar entry',
      () =>
        replaceFile(
          'uploads.tar.gz',
          gzipSync(Buffer.concat([tarEntry('uploads/ok', PNG), tarEntry('uploads/../evil', PNG), Buffer.alloc(1024)])),
          { count: 2, bytes: 2 * PNG.length },
        ),
      /unsafe name/,
    ],
    ['an upload count mismatch', () => setManifest((m) => (m.uploads.count += 1)), /count/],
    ['an upload bytes mismatch', () => setManifest((m) => (m.uploads.bytes += 1)), /bytes/],
  ])('%s', async (_label, tamper, message) => {
    tamper()
    const before = liveSnapshot()

    const err = await runFailing([NAME])

    expect(err.message).toMatch(message)
    expect(existsSync(staging())).toBe(false)
    expect(existsSync(restore())).toBe(false)
    expect(existsSync(path.join(dataDir, 'evil'))).toBe(false)
    expect(liveSnapshot()).toEqual(before)
  })

  it('stops a download without Content-Length as soon as it grows past the manifest size', async () => {
    const oversized = Buffer.concat([body(DB_FILE_NAME), Buffer.alloc(64 * 1024)])
    fake.intercept = (req, res) => {
      if (req.key !== key(NAME, DB_FILE_NAME)) return false
      res.writeHead(200) // chunked: no Content-Length to check up front
      res.end(oversized)
      return true
    }
    const err = await runFailing([NAME])
    expect(err.message).toMatch(/notes\.db is larger than/)
    expect(existsSync(staging())).toBe(false)
    expect(existsSync(restore())).toBe(false)
  })

  it('a failed download (S3 error mid-restore) stages nothing', async () => {
    fake.intercept = (req, res) => {
      if (req.key !== key(NAME, 'uploads.tar.gz')) return false
      fake.error(res, 500, 'InternalError', 'boom')
      return true
    }
    const err = await runFailing([NAME])
    expect(err.message).toContain('InternalError')
    expect(existsSync(staging())).toBe(false)
    expect(existsSync(restore())).toBe(false)
  })
})
