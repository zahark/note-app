// Off-site backups: one upload run against a local fake S3 server (never real R2), pruning, the state
// file, and the scheduler in app.ts (fake timers, injected run/prune).
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import Database from 'better-sqlite3'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp, OFFSITE_CHECK_INTERVAL_MS, OFFSITE_FIRST_CHECK_MS, scheduleOffsiteBackup } from '../src/app.js'
import type { OffsiteBackupConfig } from '../src/config.js'
import { DB_FILE_NAME, openDataDb, type Db } from '../src/db/index.js'
import { storeUpload } from '../src/services/attachments.js'
import { BackupError, readUploadsArchive } from '../src/services/backup.js'
import {
  backupNameTime,
  isOffsiteBackupDue,
  MANIFEST_NAME,
  OFFSITE_STATE_FILE,
  offsiteBackupTarget,
  pruneOffsiteBackups,
  readOffsiteState,
  runOffsiteBackup,
  writeOffsiteState,
  type OffsiteBackupResult,
  type OffsiteManifest,
  type PruneResult,
  type RunOffsiteBackupOptions,
} from '../src/services/offsiteBackup.js'
import { S3Error } from '../src/services/s3.js'
import { DAY_MS, HOUR_MS } from '../src/units.js'
import { PNG, tmpDataDir } from './helpers/api.js'
import { seedUser, testConfig } from './helpers/auth.js'
import { FakeS3 } from './helpers/fakeS3.js'

const NOW = new Date('2026-11-13T09:30:15.000Z')
const NAME = 'notes-backup-20261113-093015'
const PREFIX = 'notes-backups/'

let dataDir: string
let tmpRoot: string
let fake: FakeS3

beforeEach(async () => {
  dataDir = tmpDataDir()
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'notes-offsite-test-'))
  fake = await new FakeS3().start()
})

afterEach(async () => {
  vi.useRealTimers()
  await fake.stop()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(tmpRoot, { recursive: true, force: true })
})

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

describe('runOffsiteBackup', () => {
  let db: Db

  beforeEach(() => {
    db = openDataDb(dataDir)
  })

  afterEach(() => {
    db.close()
  })

  async function seedUploads(): Promise<Buffer[]> {
    const userId = seedUser(db, 'alice@example.com')
    const big = Buffer.concat([PNG, Buffer.alloc(70_000, 7)])
    await storeUpload(db, dataDir, userId, { originalName: 'a.png', data: PNG })
    await storeUpload(db, dataDir, userId, { originalName: 'b.png', data: big })
    return [PNG, big]
  }

  it('uploads the archive, then the database, then the manifest, all under <prefix><name>/', async () => {
    const files = await seedUploads()
    const cfg = fake.config()

    const result = await runOffsiteBackup(dataDir, cfg, { now: NOW, tmpRoot })

    const puts = fake.requests.filter((r) => r.method === 'PUT')
    expect(puts.map((r) => r.key)).toEqual([
      `${PREFIX}${NAME}/uploads.tar.gz`,
      `${PREFIX}${NAME}/notes.db`,
      `${PREFIX}${NAME}/${MANIFEST_NAME}`,
    ])
    expect(puts.map((r) => r.headers['content-type'])).toEqual([
      'application/gzip',
      'application/vnd.sqlite3',
      'application/json',
    ])

    const archive = fake.objects.get(`${PREFIX}${NAME}/uploads.tar.gz`)!.body
    const notesDb = fake.objects.get(`${PREFIX}${NAME}/notes.db`)!.body
    const manifest = JSON.parse(fake.objects.get(`${PREFIX}${NAME}/${MANIFEST_NAME}`)!.body.toString('utf8')) as OffsiteManifest
    expect(manifest).toEqual({
      version: 1,
      name: NAME,
      createdAt: NOW.toISOString(),
      files: {
        'notes.db': { size: notesDb.length, sha256: sha256(notesDb) },
        'uploads.tar.gz': { size: archive.length, sha256: sha256(archive) },
      },
      uploads: { count: 2, bytes: files[0]!.length + files[1]!.length },
      missing: [],
    })
    expect(result).toEqual({ name: NAME, files: manifest.files })

    // the uploaded database is a real, openable copy
    const dbFile = path.join(tmpRoot, 'check.db')
    writeFileSync(dbFile, notesDb)
    const copy = new Database(dbFile, { readonly: true })
    expect(copy.prepare('SELECT count(*) FROM attachments').pluck().get()).toBe(2)
    copy.close()
    // and the archive holds exactly the packed bytes the manifest counts
    const read = await readUploadsArchive(Readable.from([archive]), () => {})
    expect(read).toEqual(manifest.uploads)

    expect(existsSync(path.join(dataDir, OFFSITE_STATE_FILE))).toBe(false)
    expect(readdirSync(tmpRoot)).toEqual(['check.db']) // the temp backup directory is gone
    expect(existsSync(path.join(dataDir, 'backups'))).toBe(false) // nothing was written to the volume
  })

  it('backs up a database without attachments', async () => {
    seedUser(db, 'alice@example.com')
    const result = await runOffsiteBackup(dataDir, fake.config(), { now: NOW, tmpRoot })
    const manifest = JSON.parse(fake.objects.get(`${PREFIX}${NAME}/${MANIFEST_NAME}`)!.body.toString('utf8')) as OffsiteManifest
    expect(manifest.uploads).toEqual({ count: 0, bytes: 0 })
    expect(result.name).toBe(NAME)
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('uploads no manifest when an earlier upload fails, and removes the temp directory', async () => {
    await seedUploads()
    fake.intercept = (req, res) => {
      if (req.method !== 'PUT' || !req.key?.endsWith('/notes.db')) return false
      fake.error(res, 500, 'InternalError', 'We encountered an internal error')
      return true
    }

    const err = await runOffsiteBackup(dataDir, fake.config(), { now: NOW, tmpRoot }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(S3Error)
    expect((err as S3Error).code).toBe('InternalError')
    expect(fake.requests.some((r) => r.key?.endsWith(MANIFEST_NAME))).toBe(false)
    expect(fake.keys()).toEqual([`${PREFIX}${NAME}/uploads.tar.gz`])
    expect(readdirSync(tmpRoot)).toEqual([])
    expect(existsSync(path.join(dataDir, OFFSITE_STATE_FILE))).toBe(false)
  })

  it('stops an upload in flight when the signal aborts, leaving no manifest and no temp directory', async () => {
    await seedUploads()
    const controller = new AbortController()
    fake.intercept = (req) => {
      if (req.method !== 'PUT') return false
      controller.abort() // the first PUT is held unanswered until the abort tears it down
      return true
    }

    await expect(runOffsiteBackup(dataDir, fake.config(), { now: NOW, tmpRoot, signal: controller.signal })).rejects.toThrow()

    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(1)
    expect(fake.keys()).toEqual([])
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('does nothing when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runOffsiteBackup(dataDir, fake.config(), { now: NOW, tmpRoot, signal: controller.signal })).rejects.toThrow()
    expect(fake.requests).toEqual([])
    expect(readdirSync(tmpRoot)).toEqual([])
  })

  it('fails with a BackupError when there is no database, removing the temp directory', async () => {
    db.close()
    rmSync(path.join(dataDir, DB_FILE_NAME))
    await expect(runOffsiteBackup(dataDir, fake.config(), { now: NOW, tmpRoot })).rejects.toThrow(BackupError)
    expect(fake.requests).toEqual([])
    expect(readdirSync(tmpRoot)).toEqual([])
    db = openDataDb(dataDir) // for afterEach
  })
})

describe('pruneOffsiteBackups', () => {
  const PRUNE_NOW = new Date('2026-11-13T12:00:00.000Z')

  /** The backup name of a snapshot taken `days` days before PRUNE_NOW. */
  function nameAgo(days: number): string {
    const t = new Date(PRUNE_NOW.getTime() - days * DAY_MS)
    return `notes-backup-${t.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`
  }

  function addComplete(name: string): void {
    for (const file of ['uploads.tar.gz', 'notes.db', MANIFEST_NAME]) fake.put(`${PREFIX}${name}/${file}`, 'x')
  }

  function addIncomplete(name: string): void {
    fake.put(`${PREFIX}${name}/uploads.tar.gz`, 'x')
    fake.put(`${PREFIX}${name}/notes.db`, 'x')
  }

  const backupsLeft = () =>
    [...new Set(fake.keys().map((key) => key.slice(PREFIX.length).split('/')[0]))].filter((n) => backupNameTime(n ?? '') !== null).sort()

  it('deletes complete backups older than keepDays beyond the newest 7', async () => {
    const days = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 40, 41]
    for (const d of days) addComplete(nameAgo(d))

    const result: PruneResult = await pruneOffsiteBackups(fake.config({ keepDays: 30 }), PRUNE_NOW)

    expect(result.deleted.sort()).toEqual([nameAgo(40), nameAgo(41)].sort())
    expect(backupsLeft()).toEqual(days.slice(0, 10).map(nameAgo).sort())
  })

  it('always keeps the newest 7 complete backups, even when all are past keepDays', async () => {
    const days = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]
    for (const d of days) addComplete(nameAgo(d))

    const result = await pruneOffsiteBackups(fake.config({ keepDays: 30 }), PRUNE_NOW)

    expect(result.deleted.sort()).toEqual([nameAgo(107), nameAgo(108), nameAgo(109)].sort())
    expect(backupsLeft()).toEqual(days.slice(0, 7).map(nameAgo).sort())
  })

  it('keeps more than 7 when they are all within keepDays', async () => {
    for (let d = 0; d < 10; d++) addComplete(nameAgo(d))
    const result = await pruneOffsiteBackups(fake.config({ keepDays: 30 }), PRUNE_NOW)
    expect(result.deleted).toEqual([])
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toEqual([])
  })

  it('deletes incomplete backups older than a day, which never count towards the newest 7', async () => {
    for (let d = 10; d < 17; d++) addComplete(nameAgo(d)) // 7 complete ones, all within keepDays
    addIncomplete(nameAgo(2))
    addIncomplete(nameAgo(1.5))
    addIncomplete(nameAgo(0.5)) // may still be uploading

    const result = await pruneOffsiteBackups(fake.config({ keepDays: 30 }), PRUNE_NOW)

    expect(result.deleted.sort()).toEqual([nameAgo(2), nameAgo(1.5)].sort())
    expect(backupsLeft()).toContain(nameAgo(0.5))
    expect(fake.keys().filter((k) => k.includes(nameAgo(2)))).toEqual([])
  })

  it('deletes a backup manifest first, so an interrupted prune leaves an incomplete backup', async () => {
    for (let d = 0; d < 7; d++) addComplete(nameAgo(d))
    addComplete(nameAgo(50))

    await pruneOffsiteBackups(fake.config({ keepDays: 30 }), PRUNE_NOW)

    const deletes = fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.key)
    expect(deletes[0]).toBe(`${PREFIX}${nameAgo(50)}/${MANIFEST_NAME}`)
    expect(deletes.slice(1).sort()).toEqual([`${PREFIX}${nameAgo(50)}/notes.db`, `${PREFIX}${nameAgo(50)}/uploads.tar.gz`])
  })

  it('leaves keys it does not recognise alone', async () => {
    for (let d = 0; d < 7; d++) addComplete(nameAgo(d))
    const old = nameAgo(400)
    addComplete(old)
    const unknown = [
      `${PREFIX}README.txt`,
      `${PREFIX}other/notes.db`,
      `${PREFIX}notes-backup-2020/notes.db`,
      `${PREFIX}${old}/extra.txt`,
      `${PREFIX}${old}/nested/notes.db`,
      `${PREFIX}notes-backup-20200101-000000.partial/notes.db`,
    ]
    for (const key of unknown) fake.put(key, 'keep me')
    fake.put(`elsewhere/${nameAgo(400)}/notes.db`, 'keep me')

    const result = await pruneOffsiteBackups(fake.config({ keepDays: 30 }), PRUNE_NOW)

    expect(result.deleted).toEqual([old])
    for (const key of [...unknown, `elsewhere/${nameAgo(400)}/notes.db`]) expect(fake.objects.has(key)).toBe(true)
    expect(fake.objects.has(`${PREFIX}${old}/notes.db`)).toBe(false)
  })

  it('deletes nothing when listing fails', async () => {
    addComplete(nameAgo(400))
    fake.intercept = (req, res) => {
      if (req.method !== 'GET' || req.key !== null) return false
      fake.error(res, 403, 'AccessDenied', 'Access Denied')
      return true
    }

    await expect(pruneOffsiteBackups(fake.config({ keepDays: 30 }), PRUNE_NOW)).rejects.toThrow(S3Error)

    expect(fake.requests.filter((r) => r.method === 'DELETE')).toEqual([])
    expect(fake.keys()).toHaveLength(3)
  })
})

describe('state file', () => {
  it('is null when missing, unreadable or malformed', () => {
    expect(readOffsiteState(dataDir)).toBeNull()
    const file = path.join(dataDir, OFFSITE_STATE_FILE)
    writeFileSync(file, '{not json')
    expect(readOffsiteState(dataDir)).toBeNull()
    writeFileSync(file, JSON.stringify({ lastSuccessAt: 'yesterday', lastBackup: NAME }))
    expect(readOffsiteState(dataDir)).toBeNull()
    writeFileSync(file, JSON.stringify({ lastSuccessAt: NOW.toISOString() }))
    expect(readOffsiteState(dataDir)).toBeNull()
    writeFileSync(file, 'null')
    expect(readOffsiteState(dataDir)).toBeNull()
  })

  it('is written atomically and read back', () => {
    writeOffsiteState(dataDir, { lastSuccessAt: '2026-01-01T00:00:00.000Z', lastBackup: 'notes-backup-20260101-000000' })
    writeOffsiteState(dataDir, { lastSuccessAt: NOW.toISOString(), lastBackup: NAME })
    expect(readOffsiteState(dataDir)).toEqual({ lastSuccessAt: NOW.toISOString(), lastBackup: NAME })
    expect(readdirSync(dataDir)).toEqual([OFFSITE_STATE_FILE]) // no temp file left behind
  })

  it('makes a backup due when missing, old enough or in the future', () => {
    const state = { lastSuccessAt: NOW.toISOString(), lastBackup: NAME }
    const t = NOW.getTime()
    expect(isOffsiteBackupDue(null, DAY_MS, t)).toBe(true)
    expect(isOffsiteBackupDue(state, DAY_MS, t + DAY_MS - 1)).toBe(false)
    expect(isOffsiteBackupDue(state, DAY_MS, t + DAY_MS)).toBe(true)
    expect(isOffsiteBackupDue(state, DAY_MS, t - 1)).toBe(true)
  })
})

describe('offsiteBackupTarget', () => {
  it('names only the endpoint host, bucket and prefix', () => {
    const cfg = fake.config()
    const target = offsiteBackupTarget(cfg)
    expect(target).toEqual({ endpoint: cfg.endpoint.host, bucket: cfg.bucket, prefix: cfg.prefix })
    expect(JSON.stringify(target)).not.toContain(cfg.secretAccessKey)
    expect(JSON.stringify(target)).not.toContain(cfg.accessKeyId)
  })
})

describe('scheduleOffsiteBackup', () => {
  const START = new Date('2026-11-13T00:00:00.000Z')
  let cfg: OffsiteBackupConfig
  let logs: Array<{ msg: string; [key: string]: unknown }>
  let app: FastifyInstance

  const okResult = (name = NAME): OffsiteBackupResult => ({
    name,
    files: { 'notes.db': { size: 10, sha256: 'a'.repeat(64) }, 'uploads.tar.gz': { size: 20, sha256: 'b'.repeat(64) } },
  })

  type RunFn = (dataDir: string, cfg: OffsiteBackupConfig, opts?: RunOffsiteBackupOptions) => Promise<OffsiteBackupResult>
  type PruneFn = (cfg: OffsiteBackupConfig, now: Date, signal?: AbortSignal) => Promise<PruneResult>

  function makeApp(run: RunFn, prune: PruneFn = vi.fn(async () => ({ deleted: [] }))): FastifyInstance {
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) logs.push(JSON.parse(line))
        done()
      },
    })
    app = Fastify({ logger: { level: 'info', stream } })
    scheduleOffsiteBackup(app, { dataDir, cfg }, run, prune)
    return app
  }

  const messages = () => logs.map((l) => l.msg)
  const stateFile = () => path.join(dataDir, OFFSITE_STATE_FILE)

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(START)
    cfg = fake.config({ endpoint: new URL('https://acct.r2.example.com'), intervalMs: DAY_MS })
    logs = []
  })

  afterEach(async () => {
    await app.close()
  })

  it('runs one minute after start when there is no state file, then records it and prunes', async () => {
    const run = vi.fn<RunFn>(async () => okResult())
    const prune = vi.fn<PruneFn>(async () => ({ deleted: ['notes-backup-20261001-000000'] }))
    makeApp(run, prune)
    await app.ready()
    expect(run).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(OFFSITE_FIRST_CHECK_MS - 1)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(run).toHaveBeenCalledTimes(1)
    const [runDir, runCfg, opts] = run.mock.calls[0]!
    expect(runDir).toBe(dataDir)
    expect(runCfg).toBe(cfg)
    const startedAt = new Date(START.getTime() + OFFSITE_FIRST_CHECK_MS)
    expect(opts?.now).toEqual(startedAt)
    expect(opts?.signal).toBeInstanceOf(AbortSignal)

    expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toEqual({ lastSuccessAt: startedAt.toISOString(), lastBackup: NAME })
    expect(readdirSync(dataDir)).toEqual([OFFSITE_STATE_FILE])
    expect(prune).toHaveBeenCalledTimes(1)
    expect(prune.mock.calls[0]![0]).toBe(cfg)
    expect(prune.mock.invocationCallOrder[0]!).toBeGreaterThan(run.mock.invocationCallOrder[0]!)
    expect(messages()).toEqual(['offsite backup uploaded', 'old offsite backups pruned'])
    expect(logs[0]).toMatchObject({ name: NAME, bucket: cfg.bucket, endpoint: 'acct.r2.example.com', notesDbBytes: 10 })
  })

  it('runs when the state file is unreadable', async () => {
    writeFileSync(stateFile(), 'garbage')
    const run = vi.fn<RunFn>(async () => okResult())
    makeApp(run)
    await app.ready()
    await vi.advanceTimersByTimeAsync(OFFSITE_FIRST_CHECK_MS)
    expect(run).toHaveBeenCalledTimes(1)
    expect(readOffsiteState(dataDir)?.lastBackup).toBe(NAME)
  })

  it('runs when the last success is older than the interval', async () => {
    writeOffsiteState(dataDir, { lastSuccessAt: new Date(START.getTime() - DAY_MS).toISOString(), lastBackup: 'old' })
    const run = vi.fn<RunFn>(async () => okResult())
    makeApp(run)
    await app.ready()
    await vi.advanceTimersByTimeAsync(OFFSITE_FIRST_CHECK_MS)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('skips while the last success is fresh and runs at the first hourly check after it is due', async () => {
    // due 2 hours after start: the checks at +1 min and +1 h 1 min skip, the one at +2 h 1 min runs
    writeOffsiteState(dataDir, { lastSuccessAt: new Date(START.getTime() - DAY_MS + 2 * HOUR_MS).toISOString(), lastBackup: 'old' })
    const run = vi.fn<RunFn>(async () => okResult())
    const prune = vi.fn<PruneFn>(async () => ({ deleted: [] }))
    makeApp(run, prune)
    await app.ready()

    await vi.advanceTimersByTimeAsync(OFFSITE_FIRST_CHECK_MS + OFFSITE_CHECK_INTERVAL_MS)
    expect(run).not.toHaveBeenCalled()
    expect(prune).not.toHaveBeenCalled()
    expect(readOffsiteState(dataDir)?.lastBackup).toBe('old')

    await vi.advanceTimersByTimeAsync(OFFSITE_CHECK_INTERVAL_MS)
    expect(run).toHaveBeenCalledTimes(1)
    expect(readOffsiteState(dataDir)?.lastBackup).toBe(NAME)

    // the next 23 checks find it fresh
    await vi.advanceTimersByTimeAsync(23 * OFFSITE_CHECK_INTERVAL_MS)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(OFFSITE_CHECK_INTERVAL_MS)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('records nothing and prunes nothing after a failure, and retries at the next hourly check', async () => {
    const run = vi
      .fn<RunFn>()
      .mockRejectedValueOnce(new S3Error(403, 'AccessDenied', 'Access Denied'))
      .mockResolvedValueOnce(okResult())
    const prune = vi.fn<PruneFn>(async () => ({ deleted: [] }))
    makeApp(run, prune)
    await app.ready()

    await vi.advanceTimersByTimeAsync(OFFSITE_FIRST_CHECK_MS)
    expect(run).toHaveBeenCalledTimes(1)
    expect(existsSync(stateFile())).toBe(false)
    expect(prune).not.toHaveBeenCalled()
    expect(logs.find((l) => l.msg === 'offsite backup failed')).toMatchObject({
      error: 'S3 AccessDenied (HTTP 403): Access Denied',
      bucket: cfg.bucket,
    })

    await vi.advanceTimersByTimeAsync(OFFSITE_CHECK_INTERVAL_MS)
    expect(run).toHaveBeenCalledTimes(2)
    expect(readOffsiteState(dataDir)?.lastBackup).toBe(NAME)
    expect(prune).toHaveBeenCalledTimes(1)
  })

  it('keeps the success when pruning fails', async () => {
    const run = vi.fn<RunFn>(async () => okResult())
    const prune = vi.fn<PruneFn>(async () => {
      throw new S3Error(500, 'InternalError', 'boom')
    })
    makeApp(run, prune)
    await app.ready()
    await vi.advanceTimersByTimeAsync(OFFSITE_FIRST_CHECK_MS)

    expect(readOffsiteState(dataDir)?.lastBackup).toBe(NAME)
    expect(messages()).toEqual(['offsite backup uploaded', 'offsite backup prune failed'])
  })

  it('never runs two at once', async () => {
    let finish: (r: OffsiteBackupResult) => void = () => {}
    const run = vi.fn<RunFn>(
      (_dir, _cfg, opts) =>
        new Promise((resolve, reject) => {
          finish = resolve
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    makeApp(run)
    await app.ready()

    await vi.advanceTimersByTimeAsync(OFFSITE_FIRST_CHECK_MS + 3 * OFFSITE_CHECK_INTERVAL_MS)
    expect(run).toHaveBeenCalledTimes(1)

    finish(okResult())
    await vi.advanceTimersByTimeAsync(0)
    expect(readOffsiteState(dataDir)?.lastBackup).toBe(NAME)
    // the success counts from its snapshot time (the first check), so a day later it is due again
    await vi.advanceTimersByTimeAsync(DAY_MS - 3 * OFFSITE_CHECK_INTERVAL_MS - 1)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(OFFSITE_CHECK_INTERVAL_MS)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('app.close() aborts an upload in flight, waits for it and stops the timer', async () => {
    let signal: AbortSignal | undefined
    const run = vi.fn<RunFn>(
      (_dir, _cfg, opts) =>
        new Promise((_resolve, reject) => {
          signal = opts?.signal
          signal?.addEventListener('abort', () => reject(signal?.reason as Error))
        }),
    )
    const prune = vi.fn<PruneFn>(async () => ({ deleted: [] }))
    makeApp(run, prune)
    await app.ready()
    await vi.advanceTimersByTimeAsync(OFFSITE_FIRST_CHECK_MS)
    expect(run).toHaveBeenCalledTimes(1)
    expect(signal?.aborted).toBe(false)

    await app.close()

    expect(signal?.aborted).toBe(true)
    expect(messages()).toContain('offsite backup cancelled by shutdown')
    expect(messages()).not.toContain('offsite backup failed')
    expect(existsSync(stateFile())).toBe(false)
    expect(prune).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3 * DAY_MS)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never runs when closed before the first check', async () => {
    const run = vi.fn<RunFn>(async () => okResult())
    makeApp(run)
    await app.ready()
    await app.close()
    await vi.advanceTimersByTimeAsync(3 * DAY_MS)
    expect(run).not.toHaveBeenCalled()
  })

  it('does not hold up listen', async () => {
    const run = vi.fn<RunFn>(async () => okResult())
    makeApp(run)
    await app.listen({ host: '127.0.0.1', port: 0 })
    expect(run).not.toHaveBeenCalled()
    const res = await app.inject({ method: 'GET', url: '/missing' })
    expect(res.statusCode).toBe(404)
    await vi.advanceTimersByTimeAsync(OFFSITE_FIRST_CHECK_MS)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never logs the credentials', async () => {
    const run = vi
      .fn<RunFn>()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:443'))
      .mockResolvedValueOnce(okResult())
    makeApp(run)
    await app.ready()
    await vi.advanceTimersByTimeAsync(OFFSITE_FIRST_CHECK_MS + OFFSITE_CHECK_INTERVAL_MS)
    expect(messages()).toEqual(['offsite backup failed', 'offsite backup uploaded'])
    const text = JSON.stringify(logs)
    expect(text).not.toContain(cfg.secretAccessKey)
    expect(text).not.toContain(cfg.accessKeyId)
  })
})

describe('buildApp offsiteBackup option', () => {
  let db: Db

  beforeEach(() => {
    db = openDataDb(dataDir)
    seedUser(db, 'alice@example.com')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    db.close()
  })

  const config = () => ({ ...testConfig({ DATA_DIR: dataDir }), offsiteBackup: fake.config() })

  it('is off by default', async () => {
    const app = buildApp({ config: config(), db })
    await app.ready()
    await vi.advanceTimersByTimeAsync(2 * OFFSITE_FIRST_CHECK_MS)
    await app.close()
    expect(fake.requests).toEqual([])
    expect(existsSync(path.join(dataDir, OFFSITE_STATE_FILE))).toBe(false)
  })

  it('when on, uploads a backup to the configured bucket and records it', async () => {
    const app = buildApp({ config: config(), db, offsiteBackup: true })
    await app.ready()
    try {
      await vi.advanceTimersByTimeAsync(OFFSITE_FIRST_CHECK_MS)
      await vi.waitFor(() => expect(existsSync(path.join(dataDir, OFFSITE_STATE_FILE))).toBe(true), { timeout: 10_000 })
      const state = readOffsiteState(dataDir)!
      expect(fake.keys()).toEqual([
        `${PREFIX}${state.lastBackup}/${MANIFEST_NAME}`,
        `${PREFIX}${state.lastBackup}/notes.db`,
        `${PREFIX}${state.lastBackup}/uploads.tar.gz`,
      ])
    } finally {
      await app.close()
    }
  })

  it('does nothing when on but the config has no off-site backup', async () => {
    const app = buildApp({ config: testConfig({ DATA_DIR: dataDir }), db, offsiteBackup: true })
    await app.ready()
    await vi.advanceTimersByTimeAsync(2 * OFFSITE_FIRST_CHECK_MS)
    await app.close()
    expect(fake.requests).toEqual([])
  })
})
