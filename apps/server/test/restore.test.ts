// Startup apply of a staged restore (`applyStagedRestore`): stages are made by the real `restore:offsite`
// CLI from backups in the fake S3 server (never real R2), then copied into each test's DATA_DIR. Crashes
// are simulated by throwing from the `afterStep` seam after each change on disk; running the apply again
// must always converge on the same end state, and `abort` must always get the old data back.
import { createHash } from 'node:crypto'
import fs, { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { main as restoreOffsiteMain } from '../src/cli/restoreOffsite.js'
import { DB_FILE_NAME, openDataDb } from '../src/db/index.js'
import { storeUpload } from '../src/services/attachments.js'
import { runOffsiteBackup } from '../src/services/offsiteBackup.js'
import {
  applyStagedRestore,
  RestoreError,
  type ApplyRestoreOptions,
  type RestoreOutcome,
} from '../src/services/restore.js'
import { PNG, tmpDataDir } from './helpers/api.js'
import { seedUser } from './helpers/auth.js'
import { FAKE_S3_BUCKET, FakeS3 } from './helpers/fakeS3.js'

const NAME = 'notes-backup-20261113-093015'
const EMPTY_NAME = 'notes-backup-20261114-093015'
const BIG = Buffer.concat([PNG, Buffer.alloc(70_000, 7)])
const ALICE = 'alice@example.com'
const BOB = 'bob@example.com'

type Layout = 'old data with uploads and WAL' | 'old data without uploads' | 'no old data'
const LAYOUTS: Layout[] = ['old data with uploads and WAL', 'old data without uploads', 'no old data']
type Stage = typeof NAME | typeof EMPTY_NAME

/** A directory tree as relative path → SHA-256 of a file, or `dir`. */
type Tree = Record<string, string>

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

let fake: FakeS3
let sourceDir: string
/** One DATA_DIR per backup, with that backup staged in `restore/` by the CLI. */
const stageDirs = new Map<Stage, string>()
/** One DATA_DIR per layout holding the old data, as a crashed (never cleanly closed) app left it. */
const oldDirs = new Map<Layout, string>()
let dataDir: string
let logs: { level: 'info' | 'warn'; message: string }[]

const restoreDir = () => path.join(dataDir, 'restore')
const previousDir = () => path.join(dataDir, 'restore-previous')

function cliEnv(dir: string): NodeJS.ProcessEnv {
  return {
    DATA_DIR: dir,
    BACKUP_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    BACKUP_S3_BUCKET: FAKE_S3_BUCKET,
    BACKUP_S3_ACCESS_KEY_ID: 'AKIDFAKEKEY',
    BACKUP_S3_SECRET_ACCESS_KEY: 'fake-secret-access-key-value',
  }
}

/** Stages a backup into `dir` with the real CLI. */
async function stageWithCli(dir: string, name: Stage): Promise<void> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await restoreOffsiteMain([name], { env: cliEnv(dir), endpoint: fake.endpoint })
  } finally {
    spy.mockRestore()
  }
}

/** Old data: bob (and one upload), with the database's WAL and SHM left behind as by a killed process. */
async function makeOldData(withUploads: boolean): Promise<string> {
  const dir = tmpDataDir()
  const db = openDataDb(dir)
  db.pragma('wal_autocheckpoint = 0')
  const bob = seedUser(db, BOB)
  if (withUploads) await storeUpload(db, dir, bob, { originalName: 'live.png', data: PNG })
  const copies = new Map<string, Buffer>()
  for (const file of [DB_FILE_NAME, `${DB_FILE_NAME}-wal`, `${DB_FILE_NAME}-shm`]) {
    const full = path.join(dir, file)
    if (existsSync(full)) copies.set(file, readFileSync(full))
  }
  db.close() // checkpoints and deletes the WAL, so put the crash-time files back
  for (const [file, data] of copies) writeFileSync(path.join(dir, file), data)
  expect(existsSync(path.join(dir, `${DB_FILE_NAME}-wal`))).toBe(true)
  return dir
}

beforeAll(async () => {
  fake = await new FakeS3().start()
  sourceDir = tmpDataDir()
  const source = openDataDb(sourceDir)
  const alice = seedUser(source, ALICE)
  await storeUpload(source, sourceDir, alice, { originalName: 'a.png', data: PNG })
  await storeUpload(source, sourceDir, alice, { originalName: 'b.png', data: BIG })
  await runOffsiteBackup(sourceDir, fake.config(), { now: new Date('2026-11-13T09:30:15.000Z') })
  source.prepare('DELETE FROM attachments').run()
  await runOffsiteBackup(sourceDir, fake.config(), { now: new Date('2026-11-14T09:30:15.000Z') })
  source.close()

  for (const name of [NAME, EMPTY_NAME] as const) {
    const dir = tmpDataDir()
    await stageWithCli(dir, name)
    stageDirs.set(name, dir)
  }
  oldDirs.set('old data with uploads and WAL', await makeOldData(true))
  oldDirs.set('old data without uploads', await makeOldData(false))
  oldDirs.set('no old data', tmpDataDir())
})

afterAll(async () => {
  await fake.stop()
  for (const dir of [sourceDir, ...stageDirs.values(), ...oldDirs.values()]) {
    rmSync(dir, { recursive: true, force: true })
  }
})

beforeEach(() => {
  dataDir = tmpDataDir()
  logs = []
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dataDir, { recursive: true, force: true })
})

/** Crash tests simulate a crash after a step, not lost writes, so the (slow) fsyncs can be skipped there. */
const skipFsync = () => vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {})

function tree(dir: string): Tree {
  const out: Tree = {}
  if (!existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name)
    out[path.relative(dir, full)] = entry.isDirectory() ? 'dir' : sha256(readFileSync(full))
  }
  return out
}

/** Fills DATA_DIR with a layout's old data and stages a backup in `restore/`. */
function setUp(layout: Layout, stage: Stage = NAME): Tree {
  cpSync(oldDirs.get(layout)!, dataDir, { recursive: true })
  const old = tree(dataDir)
  cpSync(path.join(stageDirs.get(stage)!, 'restore'), restoreDir(), { recursive: true })
  return old
}

/** What DATA_DIR holds after the backup is live: its database and exactly its uploads, nothing else. */
function restoredTree(stage: Stage = NAME): Tree {
  const out: Tree = {}
  for (const [rel, hash] of Object.entries(tree(path.join(stageDirs.get(stage)!, 'restore')))) {
    if (rel !== 'READY') out[rel] = hash
  }
  return out
}

function apply(options: Partial<ApplyRestoreOptions> = {}): RestoreOutcome {
  return applyStagedRestore(dataDir, {
    abort: false,
    log: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
    },
    ...options,
  })
}

/** Applies, simulating a crash right after the `n`-th change on disk (0-based). */
function applyCrashingAt(n: number, options: Partial<ApplyRestoreOptions> = {}): void {
  let count = 0
  const crash = () => {
    if (count++ === n) throw new Error('simulated crash')
  }
  expect(() => apply({ ...options, afterStep: crash })).toThrow(RestoreError)
  expect(count).toBe(n + 1)
}

/** Every change an uninterrupted apply makes, in order. */
function stepsOf(layout: Layout, stage: Stage = NAME, options: Partial<ApplyRestoreOptions> = {}): string[] {
  setUp(layout, stage)
  const steps: string[] = []
  apply({ ...options, afterStep: (s) => steps.push(s) })
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(dataDir)
  return steps
}

/** The users of the database in DATA_DIR, opened the way the server opens it. */
function usersOf(dir = dataDir): string[] {
  const db = openDataDb(dir)
  try {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    return db.prepare('SELECT email FROM users ORDER BY email').pluck().all() as string[]
  } finally {
    db.close()
  }
}

/** Resets DATA_DIR between the cases of one test. */
function reset(): void {
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(dataDir)
  logs = []
}

describe('applyStagedRestore: nothing staged', () => {
  it('changes nothing when there is no restore/', () => {
    cpSync(oldDirs.get('old data with uploads and WAL')!, dataDir, { recursive: true })
    const before = tree(dataDir)
    expect(apply()).toBe('none')
    expect(tree(dataDir)).toEqual(before)
    expect(logs).toEqual([])
  })

  it('also works when DATA_DIR does not exist yet', () => {
    rmSync(dataDir, { recursive: true })
    expect(apply()).toBe('none')
    expect(existsSync(dataDir)).toBe(false)
  })

  it('deletes restore/ without READY together with a leftover restore-previous/ and continues', () => {
    const old = setUp('old data with uploads and WAL')
    rmSync(path.join(restoreDir(), 'READY'))
    mkdirSync(path.join(previousDir(), 'uploads'), { recursive: true })
    writeFileSync(path.join(previousDir(), DB_FILE_NAME), 'superseded')

    expect(apply()).toBe('cleaned')
    expect(tree(dataDir)).toEqual(old)
    expect(logs).toEqual([{ level: 'info', message: expect.stringMatching(/restore\/, restore-previous\//) }])
  })

  it('deletes a leftover restore-previous/ alone', () => {
    const old = setUp('old data with uploads and WAL')
    rmSync(restoreDir(), { recursive: true })
    mkdirSync(path.join(previousDir(), 'uploads'), { recursive: true })
    writeFileSync(path.join(previousDir(), 'uploads', 'x'), 'superseded')

    expect(apply()).toBe('cleaned')
    expect(tree(dataDir)).toEqual(old)
  })

  it('warns that RESTORE_ABORT is still set when nothing is staged', () => {
    expect(apply({ abort: true })).toBe('none')
    expect(logs).toEqual([{ level: 'warn', message: expect.stringMatching(/RESTORE_ABORT.*unset/) }])
  })
})

describe('applyStagedRestore: a complete swap', () => {
  it('swaps the staged backup in, keeps the old data aside until the end, and the database opens restored', () => {
    const old = setUp('old data with uploads and WAL')
    const fsync = vi.spyOn(fs, 'fsyncSync')
    let previousAtCleanup: Tree | undefined
    const steps: string[] = []
    const outcome = apply({
      afterStep: (s) => {
        steps.push(s)
        if (s === 'removed restore/READY') previousAtCleanup = tree(previousDir())
      },
    })

    expect(outcome).toBe('restored')
    // every rename was made durable (directories fsynced)
    expect(fsync.mock.calls.length).toBeGreaterThanOrEqual(steps.length)
    // the old database, its WAL and SHM, and its uploads were all moved aside, untouched
    expect(previousAtCleanup).toEqual(old)
    expect(steps.slice(0, 9)).toEqual([
      'created restore-previous/',
      'moved notes.db-wal to restore-previous/',
      'moved notes.db-shm to restore-previous/',
      'moved notes.db to restore-previous/',
      'moved notes.db into place',
      'moved uploads to restore-previous/',
      'moved uploads into place',
      'removed restore/READY',
      'removed restore/',
    ])
    // the old data is deleted only at the very end
    expect(steps.slice(9).sort()).toEqual(
      ['notes.db', 'notes.db-shm', 'notes.db-wal', 'uploads', ''].map((e) => `removed restore-previous/${e}`).sort(),
    )
    expect(steps.at(-1)).toBe('removed restore-previous/')

    expect(tree(dataDir)).toEqual(restoredTree())
    expect(Object.keys(restoredTree()).filter((p) => p.startsWith('uploads/'))).toHaveLength(2)
    // no old WAL was replayed into the restored database
    expect(usersOf()).toEqual([ALICE])
    expect(logs).toEqual([{ level: 'info', message: expect.stringContaining(NAME) }])
  })

  it.each(LAYOUTS)('restores over %s', (layout) => {
    setUp(layout)
    expect(apply()).toBe('restored')
    expect(tree(dataDir)).toEqual(restoredTree())
    expect(usersOf()).toEqual([ALICE])
  })

  it('a zero-attachment backup over live uploads leaves an empty live uploads/', () => {
    setUp('old data with uploads and WAL', EMPTY_NAME)
    expect(apply()).toBe('restored')
    expect(tree(dataDir)).toEqual({ [DB_FILE_NAME]: restoredTree(EMPTY_NAME)[DB_FILE_NAME], uploads: 'dir' })
    expect(usersOf()).toEqual([ALICE])
  })
})

describe('applyStagedRestore: an incomplete or conflicting stage stops startup and changes nothing', () => {
  it.each([
    ['READY but no uploads/ directory', () => rmSync(path.join(restoreDir(), 'uploads'), { recursive: true })],
    ['uploads/ that is a file', () => {
      rmSync(path.join(restoreDir(), 'uploads'), { recursive: true })
      writeFileSync(path.join(restoreDir(), 'uploads'), '')
    }],
    ['a notes.db whose size differs from READY', () => fs.appendFileSync(path.join(restoreDir(), DB_FILE_NAME), 'x')],
    ['no notes.db', () => rmSync(path.join(restoreDir(), DB_FILE_NAME))],
    ['a READY that is not JSON', () => writeFileSync(path.join(restoreDir(), 'READY'), 'not json')],
    ['a READY without the database size', () => writeFileSync(path.join(restoreDir(), 'READY'), '{"name":"x"}')],
  ])('%s', (_label, breakStage) => {
    setUp('old data with uploads and WAL')
    breakStage()
    const before = tree(dataDir)

    expect(() => apply()).toThrow(/Applying the staged restore failed[\s\S]*RESTORE_ABORT=1/)
    expect(tree(dataDir)).toEqual(before)
  })

  it('never overwrites a kept copy in restore-previous/', () => {
    setUp('old data with uploads and WAL')
    mkdirSync(previousDir())
    writeFileSync(path.join(previousDir(), DB_FILE_NAME), 'kept')
    const live = readFileSync(path.join(dataDir, DB_FILE_NAME))

    expect(() => apply()).toThrow(/already exists/)
    expect(readFileSync(path.join(previousDir(), DB_FILE_NAME), 'utf8')).toBe('kept')
    expect(readFileSync(path.join(dataDir, DB_FILE_NAME))).toEqual(live)
    expect(existsSync(path.join(restoreDir(), 'READY'))).toBe(true)
  })
})

describe('applyStagedRestore: crash recovery', () => {
  beforeEach(() => {
    skipFsync()
  })

  for (const layout of LAYOUTS) {
    it(`converges after a crash at any step (${layout})`, () => {
      const steps = stepsOf(layout)
      const hasOld = layout !== 'no old data'
      const expected = restoredTree()
      const restoredDb = expected[DB_FILE_NAME]
      for (let n = 0; n < steps.length; n++) {
        const old = setUp(layout)
        applyCrashingAt(n)

        // the restored database is always somewhere, and the old one is kept until the swap is complete
        const now = { ...tree(dataDir) }
        const live = now[DB_FILE_NAME]
        const staged = now[`restore/${DB_FILE_NAME}`]
        expect([live, staged], `after "${steps[n]}"`).toContain(restoredDb)
        if (hasOld && now['restore/READY'] !== undefined) {
          expect([live, now[`restore-previous/${DB_FILE_NAME}`]], `after "${steps[n]}"`).toContain(old[DB_FILE_NAME])
        }

        expect(['restored', 'cleaned', 'none']).toContain(apply())
        expect(tree(dataDir), `after a crash after "${steps[n]}"`).toEqual(expected)
        reset()
      }
      // the end state opens as the backup
      setUp(layout)
      applyCrashingAt(steps.indexOf('moved uploads into place'))
      apply()
      expect(usersOf()).toEqual([ALICE])
    })
  }

  it('converges after two crashes in a row', () => {
    const layout = 'old data with uploads and WAL'
    const steps = stepsOf(layout)
    for (let first = 0; first < steps.length - 1; first++) {
      setUp(layout)
      applyCrashingAt(first)
      const remaining: string[] = []
      apply({ afterStep: (s) => remaining.push(s) })
      for (let second = 0; second < remaining.length; second++) {
        reset()
        setUp(layout)
        applyCrashingAt(first)
        applyCrashingAt(second)
        apply()
        expect(tree(dataDir), `crashes after "${steps[first]}" and "${remaining[second]}"`).toEqual(restoredTree())
      }
      reset()
    }
  })
})

describe('applyStagedRestore: RESTORE_ABORT', () => {
  beforeEach(() => {
    skipFsync()
  })

  it('before the swap started: deletes restore/ and changes no live data', () => {
    const old = setUp('old data with uploads and WAL')
    expect(apply({ abort: true })).toBe('discarded')
    expect(tree(dataDir)).toEqual(old)
    expect(logs).toEqual([{ level: 'warn', message: expect.stringMatching(new RegExp(`${NAME}.*unset RESTORE_ABORT`, 'i')) }])
    expect(apply()).toBe('none')
    expect(usersOf()).toEqual([BOB])
  })

  it('discards a stage whose READY is unreadable', () => {
    const old = setUp('old data with uploads and WAL')
    writeFileSync(path.join(restoreDir(), 'READY'), 'garbage')
    expect(apply({ abort: true })).toBe('discarded')
    expect(tree(dataDir)).toEqual(old)
  })

  const cases: [Layout, Stage][] = [
    ...LAYOUTS.map((layout): [Layout, Stage] => [layout, NAME]),
    ['old data with uploads and WAL', EMPTY_NAME],
  ]
  for (const [layout, stage] of cases) {
    it(`rolls back a swap interrupted at any step (${layout}, ${stage === NAME ? 'with' : 'without'} attachments)`, () => {
      const steps = stepsOf(layout, stage)
      // the swap proper ends when READY is removed; after that the restore is done and not abortable
      const swapSteps = steps.indexOf('removed restore/READY')
      expect(swapSteps).toBeGreaterThan(0)
      for (let n = 0; n < swapSteps; n++) {
        const old = setUp(layout, stage)
        applyCrashingAt(n)

        expect(apply({ abort: true }), `after "${steps[n]}"`).toBe('discarded')
        expect(tree(dataDir), `abort after "${steps[n]}"`).toEqual(old)
        // a following start without RESTORE_ABORT changes nothing
        expect(apply()).toBe('none')
        expect(tree(dataDir)).toEqual(old)
        if (layout !== 'no old data') expect(usersOf()).toEqual([BOB])
        reset()
      }
    })
  }

  it('finishes a rollback that was itself interrupted at any step', () => {
    const layout = 'old data with uploads and WAL'
    const steps = stepsOf(layout)
    const swapSteps = steps.indexOf('removed restore/READY')
    for (let n = 0; n < swapSteps; n++) {
      setUp(layout)
      applyCrashingAt(n)
      const rollback: string[] = []
      apply({ abort: true, afterStep: (s) => rollback.push(s) })
      for (let m = 0; m < rollback.length; m++) {
        reset()
        const old = setUp(layout)
        applyCrashingAt(n)
        applyCrashingAt(m, { abort: true })
        apply({ abort: true })
        expect(tree(dataDir), `swap crash after "${steps[n]}", rollback crash after "${rollback[m]}"`).toEqual(old)
      }
      reset()
    }
  })
})

describe('applyStagedRestore: two restores in a row', () => {
  it.each([
    ['a start in between', true],
    ['the CLI right away', false],
  ])('a second restore after the first was interrupted while deleting restore-previous/ (%s)', async (_label, start) => {
    const layout = 'old data with uploads and WAL'
    const steps = stepsOf(layout)
    const deleting = steps.findIndex((s) => s.startsWith('removed restore-previous/'))
    expect(deleting).toBeLessThan(steps.length - 1)
    setUp(layout)
    applyCrashingAt(deleting) // one entry of restore-previous/ deleted, the rest still there
    expect(existsSync(previousDir())).toBe(true)

    if (start) expect(apply()).toBe('cleaned')
    await stageWithCli(dataDir, EMPTY_NAME)
    expect(apply()).toBe('restored')

    expect(tree(dataDir)).toEqual(restoredTree(EMPTY_NAME))
    expect(usersOf()).toEqual([ALICE])
  })
})
