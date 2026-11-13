// The server's startup sequence (`prepareServer`, what index.ts runs before listening): a staged restore is
// applied (or with RESTORE_ABORT discarded) before the database opens, a bad stage stops startup without
// opening it, and the off-site backup scheduler and its on/off log line are wired up. Stages come from the
// real `restore:offsite` CLI against the fake S3 server (never real R2).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OFFSITE_FIRST_CHECK_MS } from '../src/app.js'
import { main as restoreOffsiteMain } from '../src/cli/restoreOffsite.js'
import type { Config } from '../src/config.js'
import { DB_FILE_NAME, openDataDb } from '../src/db/index.js'
import { OFFSITE_STATE_FILE, readOffsiteState, runOffsiteBackup } from '../src/services/offsiteBackup.js'
import { RestoreError } from '../src/services/restore.js'
import { prepareServer } from '../src/startup.js'
import { tmpDataDir } from './helpers/api.js'
import { seedUser, testConfig } from './helpers/auth.js'
import { FAKE_S3_BUCKET, FakeS3 } from './helpers/fakeS3.js'

const NAME = 'notes-backup-20261113-093015'

let fake: FakeS3
let sourceDir: string
let dataDir: string
let app: FastifyInstance | undefined
let logs: Array<{ level: number; msg: string; [key: string]: unknown }>
let restoreLogs: string[]

beforeEach(async () => {
  fake = await new FakeS3().start()
  // the backup: alice with a folder
  sourceDir = tmpDataDir()
  const source = openDataDb(sourceDir)
  const alice = seedUser(source, 'alice@example.com')
  source.prepare("INSERT INTO folders (id, user_id, name, parent_folder_id) VALUES ('f1', ?, 'Trips', NULL)").run(alice)
  await runOffsiteBackup(sourceDir, fake.config(), { now: new Date('2026-11-13T09:30:15.000Z') })
  source.close()
  // the live data: bob
  dataDir = tmpDataDir()
  const live = openDataDb(dataDir)
  seedUser(live, 'bob@example.com')
  live.close()
  logs = []
  restoreLogs = []
})

afterEach(async () => {
  await app?.close()
  app = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  await fake.stop()
  rmSync(sourceDir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

async function stage(): Promise<void> {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(process, 'getuid').mockReturnValue(1000)
  await restoreOffsiteMain([NAME], {
    env: {
      DATA_DIR: dataDir,
      BACKUP_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      BACKUP_S3_BUCKET: FAKE_S3_BUCKET,
      BACKUP_S3_ACCESS_KEY_ID: 'AKIDFAKEKEY',
      BACKUP_S3_SECRET_ACCESS_KEY: 'fake-secret-access-key-value',
    },
    endpoint: fake.endpoint,
  })
  vi.restoreAllMocks()
  expect(existsSync(path.join(dataDir, 'restore', 'READY'))).toBe(true)
}

function prepare(config: Config): FastifyInstance {
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) logs.push(JSON.parse(line))
      done()
    },
  })
  app = prepareServer(config, {
    logger: { level: 'info', stream },
    restoreLog: { info: (m) => restoreLogs.push(m), warn: (m) => restoreLogs.push(m) },
    webDir: null,
  })
  return app
}

const usersOf = (a: FastifyInstance) => a.db.prepare('SELECT email FROM users').pluck().all()

describe('prepareServer', () => {
  it('applies a staged restore before it opens the database', async () => {
    await stage()
    const a = prepare(testConfig({ DATA_DIR: dataDir }))
    // had the database been opened first, its handle would still point at bob's moved-aside file
    expect(usersOf(a)).toEqual(['alice@example.com'])
    expect(existsSync(path.join(dataDir, 'restore'))).toBe(false)
    expect(existsSync(path.join(dataDir, 'restore-previous'))).toBe(false)
    expect(restoreLogs).toEqual([expect.stringContaining(`${NAME} is now the live data`)])
  })

  it('passes RESTORE_ABORT on: the stage is discarded and the old data opens', async () => {
    await stage()
    const a = prepare({ ...testConfig({ DATA_DIR: dataDir }), restoreAbort: true })
    expect(usersOf(a)).toEqual(['bob@example.com'])
    expect(existsSync(path.join(dataDir, 'restore'))).toBe(false)
    expect(restoreLogs).toEqual([expect.stringContaining('RESTORE_ABORT: discarded the staged restore')])
  })

  it('a stage that cannot be applied stops startup without creating or opening the database', async () => {
    rmSync(path.join(dataDir, DB_FILE_NAME)) // a new installation: no database yet
    await stage()
    writeFileSync(path.join(dataDir, 'restore', DB_FILE_NAME), 'not the staged database')

    expect(() => prepare(testConfig({ DATA_DIR: dataDir }))).toThrow(RestoreError)
    expect(app).toBeUndefined()
    expect(existsSync(path.join(dataDir, DB_FILE_NAME))).toBe(false)
    expect(readFileSync(path.join(dataDir, 'restore', DB_FILE_NAME), 'utf8')).toBe('not the staged database')
  })

  it('logs that off-site backups are off when BACKUP_S3_* are not set', async () => {
    const a = prepare(testConfig({ DATA_DIR: dataDir }))
    await a.ready()
    expect(logs.map((l) => l.msg)).toEqual(['notes-app server starting', 'off-site backups off (BACKUP_S3_* not set)'])
  })

  it('logs where off-site backups go (never the keys) and runs the scheduler', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const db = openDataDb(dataDir)
    const bob = db.prepare('SELECT id FROM users').pluck().get() as string
    db.prepare("INSERT INTO folders (id, user_id, name, parent_folder_id) VALUES ('f2', ?, 'Home', NULL)").run(bob)
    db.close()
    const cfg = fake.config()
    const a = prepare({ ...testConfig({ DATA_DIR: dataDir }), offsiteBackup: cfg })

    const on = logs.find((l) => l.msg === 'off-site backups on')
    expect(on).toMatchObject({ endpoint: cfg.endpoint.host, bucket: cfg.bucket, prefix: cfg.prefix, intervalHours: 24, keepDays: 30 })
    expect(JSON.stringify(logs)).not.toContain(cfg.secretAccessKey)

    await a.ready()
    await vi.advanceTimersByTimeAsync(OFFSITE_FIRST_CHECK_MS)
    await vi.waitFor(() => expect(existsSync(path.join(dataDir, OFFSITE_STATE_FILE))).toBe(true), { timeout: 10_000 })
    expect(fake.keys()).toContain(`${cfg.prefix}${readOffsiteState(dataDir)!.lastBackup}/manifest.json`)
  })
})
