// Attachment references and the sweep: `note_attachments` is rebuilt from the content on every save,
// note/folder deletes only drop references (FK cascade + trigger), and the sweep deletes an image only
// once nothing has referenced it for 7 days.
//
// Fixtures backdate the attachment's own `created_at` / `last_unlinked_at` with direct UPDATEs, and
// `now` is derived from real time: the trigger stamps with SQLite's own clock, so fake timers would
// not move it.
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp, scheduleAttachmentSweep, SWEEP_INTERVAL_MS } from '../src/app.js'
import { openDb } from '../src/db/index.js'
import { SWEEP_GRACE_SEC, sweepAttachments, uploadsDir } from '../src/services/attachments.js'
import { closeApp, makeApp, testConfig, type TestApp } from './helpers/auth.js'
import { api, doc, docWithImages, loginAs, PNG, tmpDataDir, uploadPng, type TestUser } from './helpers/api.js'

const DAY = 24 * 60 * 60
const realNow = () => Math.floor(Date.now() / 1000)

let dataDir: string
let t: TestApp
let alice: TestUser
let bob: TestUser

beforeEach(async () => {
  dataDir = tmpDataDir()
  t = await makeApp({ env: { DATA_DIR: dataDir } })
  alice = await loginAs(t, 'alice@example.com')
  bob = await loginAs(t, 'bob@example.com')
})

afterEach(async () => {
  await closeApp(t)
  rmSync(dataDir, { recursive: true, force: true })
})

// --- helpers -------------------------------------------------------------------

async function newFolder(user: TestUser, parent: string | null = null): Promise<string> {
  const res = await api(t.app, user, 'POST', '/api/folders', { name: 'f', parent_folder_id: parent })
  expect(res.statusCode).toBe(201)
  return res.json().folder.id
}

async function newNote(user: TestUser, folder: string | null = null): Promise<string> {
  const res = await api(t.app, user, 'POST', '/api/notes', { folder_id: folder, title: 'n' })
  expect(res.statusCode).toBe(201)
  return res.json().note.id
}

/** Saves content at the note's current version. */
async function save(user: TestUser, noteId: string, content: object): Promise<void> {
  const version = t.db.prepare('SELECT version FROM notes WHERE id = ?').pluck().get(noteId) as number
  const res = await api(t.app, user, 'PUT', `/api/notes/${noteId}/content`, { content, version })
  expect(res.statusCode).toBe(200)
}

const links = (noteId: string): string[] =>
  t.db
    .prepare('SELECT attachment_id FROM note_attachments WHERE note_id = ? ORDER BY attachment_id')
    .pluck()
    .all(noteId) as string[]

const attachment = (aid: string) =>
  t.db.prepare('SELECT * FROM attachments WHERE id = ?').get(aid) as
    | { storage_name: string; created_at: number; last_unlinked_at: number | null }
    | undefined

const fileExists = (aid: string): boolean => {
  const row = attachment(aid)
  return row !== undefined && existsSync(path.join(uploadsDir(dataDir), row.storage_name))
}

async function loads(user: TestUser, aid: string): Promise<boolean> {
  const res = await api(t.app, user, 'GET', `/api/attachments/${aid}`)
  return res.statusCode === 200 && res.rawPayload.equals(PNG)
}

/** Moves the attachment's own timestamps into the past (seconds before real now). */
function backdate(aid: string, { created, unlinked }: { created?: number; unlinked?: number }): void {
  if (created !== undefined) {
    t.db.prepare('UPDATE attachments SET created_at = ? WHERE id = ?').run(realNow() - created, aid)
  }
  if (unlinked !== undefined) {
    t.db.prepare('UPDATE attachments SET last_unlinked_at = ? WHERE id = ?').run(realNow() - unlinked, aid)
  }
}

/** Moves a note's timestamps into the past (to show they play no part in the sweep). */
function backdateNote(noteId: string, ago: number): void {
  t.db.prepare('UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?').run(realNow() - ago, realNow() - ago, noteId)
}

const sweep = (offset = 0) => sweepAttachments(t.db, dataDir, realNow() + offset)

// --- references on content save ------------------------------------------------

describe('note_attachments sync on content save', () => {
  it('links every own attachment named in the content', async () => {
    const [a, b] = [await uploadPng(t.app, alice), await uploadPng(t.app, alice)]
    const note = await newNote(alice)
    await save(alice, note, docWithImages(a, b, a))
    expect(links(note)).toEqual([a, b].sort())
  })

  it('a save that drops the image removes the link but keeps the attachment row and file, stamping last_unlinked_at', async () => {
    const aid = await uploadPng(t.app, alice)
    const note = await newNote(alice)
    await save(alice, note, docWithImages(aid))
    expect(attachment(aid)?.last_unlinked_at).toBeNull()

    const before = realNow()
    await save(alice, note, doc('image cut'))
    expect(links(note)).toEqual([])
    expect(fileExists(aid)).toBe(true)
    expect(attachment(aid)?.last_unlinked_at).toBeGreaterThanOrEqual(before)
    expect(await loads(alice, aid)).toBe(true)
  })

  it('a later save that references it again (undo) restores the link and the image still loads', async () => {
    const aid = await uploadPng(t.app, alice)
    const note = await newNote(alice)
    await save(alice, note, docWithImages(aid))
    await save(alice, note, doc('cut'))
    await save(alice, note, docWithImages(aid))
    expect(links(note)).toEqual([aid])
    expect(await loads(alice, aid)).toBe(true)
  })

  it('a rejected (stale-version) save changes no links', async () => {
    const aid = await uploadPng(t.app, alice)
    const note = await newNote(alice)
    await save(alice, note, docWithImages(aid))
    const res = await api(t.app, alice, 'PUT', `/api/notes/${note}/content`, { content: doc('x'), version: 1 })
    expect(res.statusCode).toBe(409)
    expect(links(note)).toEqual([aid])
  })
})

describe('cross-note references', () => {
  it('an image cut from note A and pasted into note B stays linked to B', async () => {
    const aid = await uploadPng(t.app, alice)
    const [a, b] = [await newNote(alice), await newNote(alice)]
    await save(alice, a, docWithImages(aid))
    await save(alice, a, doc('cut')) // A saves first...
    await save(alice, b, docWithImages(aid)) // ...then B
    expect(links(a)).toEqual([])
    expect(links(b)).toEqual([aid])
    expect(await sweep()).toEqual({ attachments: 0, strays: 0 })
    expect(await loads(alice, aid)).toBe(true)
  })

  it('an image copied into B survives deleting note A', async () => {
    const aid = await uploadPng(t.app, alice)
    const [a, b] = [await newNote(alice), await newNote(alice)]
    await save(alice, a, docWithImages(aid))
    await save(alice, b, docWithImages(aid))
    expect((await api(t.app, alice, 'DELETE', `/api/notes/${a}`)).statusCode).toBe(204)
    expect(links(b)).toEqual([aid])
    await sweep(30 * DAY)
    expect(await loads(alice, aid)).toBe(true)
  })

  it("an image copied into B survives deleting A's folder and a grandparent folder of A", async () => {
    const grandparent = await newFolder(alice)
    const parent = await newFolder(alice, grandparent)
    const aid = await uploadPng(t.app, alice)
    const a1 = await newNote(alice, parent)
    const a2 = await newNote(alice, parent)
    const b = await newNote(alice)
    await save(alice, a1, docWithImages(aid))
    await save(alice, a2, docWithImages(aid))
    await save(alice, b, docWithImages(aid))

    expect((await api(t.app, alice, 'DELETE', `/api/notes/${a1}`)).statusCode).toBe(204)
    expect((await api(t.app, alice, 'DELETE', `/api/folders/${parent}`)).statusCode).toBe(204)
    expect(links(a2)).toEqual([])
    expect((await api(t.app, alice, 'DELETE', `/api/folders/${grandparent}`)).statusCode).toBe(204)
    expect(links(b)).toEqual([aid])
    await sweep(30 * DAY)
    expect(await loads(alice, aid)).toBe(true)
  })

  it("a content save referencing another user's aid or an unknown aid creates no link", async () => {
    const alicesImage = await uploadPng(t.app, alice)
    const own = await uploadPng(t.app, bob)
    const note = await newNote(bob)
    await save(bob, note, docWithImages(alicesImage, '00000000-0000-4000-8000-000000000000', own))
    expect(links(note)).toEqual([own])
    expect(t.db.prepare('SELECT COUNT(*) FROM note_attachments WHERE attachment_id = ?').pluck().get(alicesImage)).toBe(0)
    // and the foreign image is still not reachable for B
    expect((await api(t.app, bob, 'GET', `/api/attachments/${alicesImage}`)).statusCode).toBe(404)
  })
})

// --- sweep -----------------------------------------------------------------------

describe('sweep', () => {
  it('an image uploaded 10 days ago in a note last saved 10 days ago that is cut now survives the sweep, and can be pasted again', async () => {
    const aid = await uploadPng(t.app, alice)
    const note = await newNote(alice)
    await save(alice, note, docWithImages(aid))
    backdate(aid, { created: 10 * DAY })
    backdateNote(note, 10 * DAY)

    await save(alice, note, doc('cut'))
    expect(await sweep()).toEqual({ attachments: 0, strays: 0 })
    expect(fileExists(aid)).toBe(true)

    const other = await newNote(alice)
    await save(alice, other, docWithImages(aid))
    expect(links(other)).toEqual([aid])
    expect(await loads(alice, aid)).toBe(true)
  })

  it('an image left unreferenced after a cut is swept only once now is more than 7 days after the cut', async () => {
    const aid = await uploadPng(t.app, alice)
    const note = await newNote(alice)
    await save(alice, note, docWithImages(aid))
    backdate(aid, { created: 10 * DAY })
    await save(alice, note, doc('cut'))
    const file = path.join(uploadsDir(dataDir), attachment(aid)!.storage_name)

    expect(await sweep(6 * DAY)).toEqual({ attachments: 0, strays: 0 })
    expect(await sweep(SWEEP_GRACE_SEC - 5)).toEqual({ attachments: 0, strays: 0 })
    expect(fileExists(aid)).toBe(true)

    expect(await sweep(SWEEP_GRACE_SEC + 60)).toEqual({ attachments: 1, strays: 0 })
    expect(attachment(aid)).toBeUndefined()
    expect(existsSync(file)).toBe(false)
    expect((await api(t.app, alice, 'GET', `/api/attachments/${aid}`)).statusCode).toBe(404)
  })

  it('an image whose only note was deleted is swept 7 days after the delete, not after its last save', async () => {
    const aid = await uploadPng(t.app, alice)
    const note = await newNote(alice)
    await save(alice, note, docWithImages(aid))
    backdate(aid, { created: 20 * DAY })
    backdateNote(note, 20 * DAY)

    expect((await api(t.app, alice, 'DELETE', `/api/notes/${note}`)).statusCode).toBe(204)
    expect(attachment(aid)?.last_unlinked_at).toBeGreaterThanOrEqual(realNow() - 5)
    expect(await sweep(6 * DAY)).toMatchObject({ attachments: 0 })
    expect(fileExists(aid)).toBe(true)
    expect(await sweep(8 * DAY)).toMatchObject({ attachments: 1 })
    expect(attachment(aid)).toBeUndefined()
  })

  it('an image whose only note sits in a nested folder deleted from the top is swept the same way', async () => {
    const top = await newFolder(alice)
    const mid = await newFolder(alice, top)
    const leaf = await newFolder(alice, mid)
    const note = await newNote(alice, leaf)
    const aid = await uploadPng(t.app, alice)
    await save(alice, note, docWithImages(aid))
    backdate(aid, { created: 20 * DAY })
    backdateNote(note, 20 * DAY)

    expect((await api(t.app, alice, 'DELETE', `/api/folders/${top}`)).statusCode).toBe(204)
    expect(links(note)).toEqual([])
    expect(await sweep(6 * DAY)).toMatchObject({ attachments: 0 })
    expect(fileExists(aid)).toBe(true)
    expect(await sweep(8 * DAY)).toMatchObject({ attachments: 1 })
    expect(attachment(aid)).toBeUndefined()
  })

  it('a never-saved upload is swept 7 days after its created_at', async () => {
    const recent = await uploadPng(t.app, alice)
    const old = await uploadPng(t.app, alice)
    backdate(old, { created: 8 * DAY })
    backdate(recent, { created: 6 * DAY })
    expect(await sweep()).toEqual({ attachments: 1, strays: 0 })
    expect(attachment(old)).toBeUndefined()
    expect(fileExists(recent)).toBe(true)
    expect(await sweep(2 * DAY)).toEqual({ attachments: 1, strays: 0 })
    expect(attachment(recent)).toBeUndefined()
  })

  it('an image still linked to any note is never swept, regardless of age', async () => {
    const aid = await uploadPng(t.app, alice)
    const note = await newNote(alice)
    await save(alice, note, docWithImages(aid))
    backdate(aid, { created: 400 * DAY, unlinked: 300 * DAY })
    backdateNote(note, 400 * DAY)
    expect(await sweep(365 * DAY)).toEqual({ attachments: 0, strays: 0 })
    expect(fileExists(aid)).toBe(true)
    expect(await loads(alice, aid)).toBe(true)
  })

  it('an upload racing a content save without it keeps its full grace period, then the next save links it', async () => {
    const note = await newNote(alice)
    // the upload lands while the editor saves content that does not contain it yet
    const [aid] = await Promise.all([uploadPng(t.app, alice), save(alice, note, doc('typing'))])
    expect(links(note)).toEqual([])
    // the racing save is not an unlink: the grace period still runs from the upload itself
    expect(attachment(aid!)?.last_unlinked_at).toBeNull()
    expect(await sweep(SWEEP_GRACE_SEC - 60)).toEqual({ attachments: 0, strays: 0 })
    expect(fileExists(aid!)).toBe(true)
    await save(alice, note, docWithImages(aid!))
    expect(links(note)).toEqual([aid])
    // once linked it is kept by the link, far past the grace period
    backdate(aid!, { created: 60 * DAY })
    expect(await sweep(60 * DAY)).toEqual({ attachments: 0, strays: 0 })
    expect(fileExists(aid!)).toBe(true)
  })

  it('does nothing when the uploads directory does not exist yet', async () => {
    rmSync(uploadsDir(dataDir), { recursive: true, force: true })
    expect(await sweep()).toEqual({ attachments: 0, strays: 0 })
  })
})

describe('stray files', () => {
  const strayPath = (name: string) => path.join(uploadsDir(dataDir), name)

  function writeStray(name: string, ageSec: number): void {
    writeFileSync(strayPath(name), PNG)
    const t0 = realNow() - ageSec
    utimesSync(strayPath(name), t0, t0)
  }

  it('a file with no row is deleted only when older than 1 hour', async () => {
    const aid = await uploadPng(t.app, alice) // also creates the uploads directory
    writeStray('old-stray', 2 * 60 * 60)
    writeStray('fresh-stray', 10 * 60)
    const known = strayPath(attachment(aid)!.storage_name)
    utimesSync(known, realNow() - 2 * 60 * 60, realNow() - 2 * 60 * 60)

    expect(await sweep()).toEqual({ attachments: 0, strays: 1 })
    expect(existsSync(strayPath('old-stray'))).toBe(false)
    expect(existsSync(strayPath('fresh-stray'))).toBe(true)
    // files that have a row are never treated as strays, however old
    expect(fileExists(aid)).toBe(true)

    expect(await sweep(60 * 60 + 60)).toEqual({ attachments: 0, strays: 1 })
    expect(existsSync(strayPath('fresh-stray'))).toBe(false)
    expect(readdirSync(uploadsDir(dataDir))).toEqual([attachment(aid)!.storage_name])
  })
})

describe('sweep scheduling', () => {
  const oldStray = () => {
    mkdirSync(uploadsDir(dataDir), { recursive: true })
    const file = path.join(uploadsDir(dataDir), 'boot-stray')
    writeFileSync(file, PNG)
    utimesSync(file, realNow() - 2 * 60 * 60, realNow() - 2 * 60 * 60)
    return file
  }

  async function bootApp(attachmentSweep: boolean, whileRunning: () => Promise<void>) {
    const db = openDb(':memory:')
    const app = buildApp({ config: testConfig({ DATA_DIR: dataDir }), db, attachmentSweep })
    await app.ready()
    try {
      await whileRunning()
    } finally {
      await app.close()
      db.close()
    }
  }

  it('with attachmentSweep on, the app sweeps once when it is ready', async () => {
    const file = oldStray()
    // the boot sweep runs in the background once the app is ready
    await bootApp(true, () => vi.waitFor(() => expect(existsSync(file)).toBe(false)))
  })

  it('is off by default, so an app never touches an uploads directory it was not asked to sweep', async () => {
    const file = oldStray()
    // a sweep would have finished well within this wait (the "on" case above takes a few ms)
    await bootApp(false, () => new Promise((r) => setTimeout(r, 50)))
    expect(existsSync(file)).toBe(true)
  })

  it('sweeps at boot, again every 24 hours, and never after the app is closed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const db = openDb(':memory:')
      const app = Fastify()
      app.decorate('db', db)
      app.decorate('config', testConfig({ DATA_DIR: dataDir }))
      const sweepFn = vi.fn(async () => ({ attachments: 0, strays: 0 }))
      scheduleAttachmentSweep(app, sweepFn)
      expect(sweepFn).not.toHaveBeenCalled()
      await app.ready()
      expect(sweepFn).toHaveBeenCalledTimes(1)
      expect(sweepFn).toHaveBeenLastCalledWith(db, dataDir, expect.any(Number))

      vi.advanceTimersByTime(SWEEP_INTERVAL_MS - 1)
      expect(sweepFn).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      expect(sweepFn).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(SWEEP_INTERVAL_MS)
      expect(sweepFn).toHaveBeenCalledTimes(3)

      await app.close()
      vi.advanceTimersByTime(3 * SWEEP_INTERVAL_MS)
      expect(sweepFn).toHaveBeenCalledTimes(3)
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
