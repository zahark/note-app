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
  // the CLI refuses to run as root; these tests must pass whoever runs them
  const uid = vi.spyOn(process, 'getuid').mockReturnValue(1000)
  try {
    await restoreOffsiteMain([name], { env: cliEnv(dir), endpoint: fake.endpoint })
  } finally {
    spy.mockRestore()
    uid.mockRestore()
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

  it('deletes a restore-staging/ left by an interrupted restore:offsite run', () => {
    const old = setUp('old data with uploads and WAL')
    rmSync(restoreDir(), { recursive: true })
    const staging = path.join(dataDir, 'restore-staging')
    mkdirSync(path.join(staging, 'uploads'), { recursive: true })
    writeFileSync(path.join(staging, DB_FILE_NAME), 'half a download')
    writeFileSync(path.join(dataDir, 'restore-staging.lock'), `${2 ** 30}\n`) // its run was killed

    expect(apply()).toBe('cleaned')
    expect(existsSync(staging)).toBe(false)
    expect(logs).toEqual([{ level: 'info', message: expect.stringContaining('restore-staging/') }])
    rmSync(path.join(dataDir, 'restore-staging.lock'))
    expect(tree(dataDir)).toEqual(old)
  })

  it('leaves restore-staging/ alone while a restore:offsite run holds the lock', () => {
    const staging = path.join(dataDir, 'restore-staging')
    mkdirSync(staging)
    writeFileSync(path.join(staging, DB_FILE_NAME), 'downloading')
    writeFileSync(path.join(dataDir, 'restore-staging.lock'), `${process.pid}\n`)

    expect(apply()).toBe('none')
    expect(readFileSync(path.join(staging, DB_FILE_NAME), 'utf8')).toBe('downloading')
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

describe('applyStagedRestore: a leftover that cannot be deleted', () => {
  /** `fs.rmSync` of `dir` fails as for a directory owned by another user; everything else is deleted. */
  function failRemoving(dir: string): void {
    const rm = fs.rmSync
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (target === dir) throw Object.assign(new Error(`EACCES: permission denied, rmdir '${dir}'`), { code: 'EACCES' })
      rm(target, options)
    })
  }

  function leaveStaging(): string {
    const staging = path.join(dataDir, 'restore-staging')
    mkdirSync(path.join(staging, 'uploads'), { recursive: true })
    writeFileSync(path.join(staging, DB_FILE_NAME), 'half a download')
    return staging
  }

  it.each([false, true])('only warns about restore-staging/ and starts (RESTORE_ABORT %s)', (abort) => {
    cpSync(oldDirs.get('old data with uploads and WAL')!, dataDir, { recursive: true })
    const staging = leaveStaging()
    const before = tree(dataDir)
    failRemoving(staging)

    expect(apply({ abort })).toBe('none')
    expect(tree(dataDir)).toEqual(before)
    expect(logs[0]).toEqual({ level: 'warn', message: expect.stringMatching(/could not remove .*restore-staging.*EACCES/) })
    expect(logs.slice(1)).toEqual(abort ? [{ level: 'warn', message: expect.stringMatching(/RESTORE_ABORT.*unset/) }] : [])
  })

  it('removes the other leftovers, keeps the finished swap live, and a later restore still applies', async () => {
    const layout = 'old data with uploads and WAL'
    const steps = stepsOf(layout)
    setUp(layout)
    applyCrashingAt(steps.indexOf('removed restore/')) // the swap is complete; restore-previous/ is left
    const restored = restoredTree()
    expect(existsSync(previousDir())).toBe(true)
    const staging = leaveStaging()
    failRemoving(previousDir())
    logs = []

    expect(apply()).toBe('cleaned')
    expect(existsSync(staging)).toBe(false)
    const live = Object.fromEntries(Object.entries(tree(dataDir)).filter(([rel]) => !rel.startsWith('restore-previous')))
    expect(live).toEqual(restored)
    expect(usersOf()).toEqual([ALICE])
    expect(logs).toEqual([
      { level: 'warn', message: expect.stringMatching(/could not remove .*restore-previous.*EACCES/) },
      { level: 'info', message: expect.stringContaining('(restore-staging/)') },
    ])

    // restore:offsite deletes the kept restore-previous/ before it stages, so the next swap starts clean
    vi.restoreAllMocks()
    await stageWithCli(dataDir, EMPTY_NAME)
    expect(existsSync(previousDir())).toBe(false)
    expect(apply()).toBe('restored')
    expect(tree(dataDir)).toEqual(restoredTree(EMPTY_NAME))
  })
})

describe('applyStagedRestore: a complete swap', () => {
  it('swaps the staged backup in, keeps the old data aside until the end, and the database opens restored', () => {
    const old = setUp('old data with uploads and WAL')
    // which paths were fsynced since the previous step
    const opened = new Map<number, string>()
    const openSync = fs.openSync.bind(fs)
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = openSync(...args)
      opened.set(fd, String(args[0]))
      return fd
    })
    let synced: string[] = []
    const fsyncSync = fs.fsyncSync.bind(fs)
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
      synced.push(opened.get(fd) ?? `fd ${fd}`)
      fsyncSync(fd)
    })
    let previousAtCleanup: Tree | undefined
    const steps: string[] = []
    const syncedPerStep: string[][] = []
    const outcome = apply({
      afterStep: (s) => {
        steps.push(s)
        syncedPerStep.push(synced.sort())
        synced = []
        if (s === 'removed restore/READY') previousAtCleanup = tree(previousDir())
      },
    })

    expect(outcome).toBe('restored')
    // the old database, its WAL and SHM, and its uploads were all moved aside, untouched
    expect(previousAtCleanup).toEqual(old)
    // the old data is deleted only at the very end
    expect(steps).toEqual([
      'created restore-previous/',
      'moved notes.db-wal to restore-previous/',
      'moved notes.db-shm to restore-previous/',
      'moved notes.db to restore-previous/',
      'moved notes.db into place',
      'moved uploads to restore-previous/',
      'moved uploads into place',
      'removed restore/READY',
      'removed restore/',
      'removed restore-previous/',
    ])
    // every change was made durable before the next one: both parent directories of each rename
    const toPrevious = [dataDir, previousDir()].sort()
    const intoPlace = [dataDir, restoreDir()].sort()
    expect(syncedPerStep).toEqual([
      [dataDir],
      toPrevious,
      toPrevious,
      toPrevious,
      intoPlace,
      toPrevious,
      intoPlace,
      [restoreDir()],
      [dataDir],
      [dataDir],
    ])

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

  it('never overwrites a kept copy in restore-previous/, and RESTORE_ABORT then asks for a check by hand', () => {
    setUp('old data with uploads and WAL')
    mkdirSync(previousDir())
    writeFileSync(path.join(previousDir(), DB_FILE_NAME), 'kept')
    const before = tree(dataDir)

    expect(() => apply()).toThrow(/already exists/)
    expect(tree(dataDir)).toEqual(before)

    // the kept copy is not one a swap made, so the rollback refuses to delete restore-previous/
    expect(() => apply({ abort: true })).toThrow(/RESTORE_ABORT is set[\s\S]*check .* by hand/)
    expect(readFileSync(path.join(previousDir(), DB_FILE_NAME), 'utf8')).toBe('kept')
    expect(tree(dataDir)[DB_FILE_NAME]).toBe(before[DB_FILE_NAME])
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

  it('a rollback that cannot finish asks for a check by hand and leaves the old data live', () => {
    const layout = 'old data with uploads and WAL'
    const steps = stepsOf(layout)
    const old = setUp(layout)
    applyCrashingAt(steps.indexOf('moved notes.db into place'))
    writeFileSync(path.join(previousDir(), 'unexpected'), 'not from the swap')

    expect(() => apply({ abort: true })).toThrow(/RESTORE_ABORT is set[\s\S]*check .* by hand/)

    expect(readFileSync(path.join(previousDir(), 'unexpected'), 'utf8')).toBe('not from the swap')
    const now = tree(dataDir)
    for (const file of [DB_FILE_NAME, `${DB_FILE_NAME}-wal`, `${DB_FILE_NAME}-shm`]) expect(now[file]).toBe(old[file])
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
    setUp(layout)
    applyCrashingAt(steps.indexOf('removed restore/'))
    // a crash in the middle of the recursive delete: part of restore-previous/ is gone, the rest is still there
    rmSync(path.join(previousDir(), 'uploads'), { recursive: true })
    rmSync(path.join(previousDir(), `${DB_FILE_NAME}-wal`))
    expect(existsSync(previousDir())).toBe(true)

    if (start) expect(apply()).toBe('cleaned')
    await stageWithCli(dataDir, EMPTY_NAME)
    expect(apply()).toBe('restored')

    expect(tree(dataDir)).toEqual(restoredTree(EMPTY_NAME))
    expect(usersOf()).toEqual([ALICE])
  })
})
