// Moves: `PATCH /api/notes/:id/move {folder_id}` and `PATCH /api/folders/:id/move {parent_folder_id}`
// (null = root). Folder cycles are rejected with 409; foreign or missing ids answer 404.
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db/index.js'
import { createFolder as repoCreateFolder } from '../src/repos/folders.js'
import { createUser } from '../src/repos/users.js'
import { isInFolderSubtree, moveFolder, moveNote } from '../src/services/tree.js'
import { closeApp, errorCode, makeApp, type TestApp } from './helpers/auth.js'
import { api, doc, loginAs, type TestUser } from './helpers/api.js'

let t: TestApp
let alice: TestUser
let bob: TestUser

beforeEach(async () => {
  t = await makeApp()
  alice = await loginAs(t, 'alice@example.com')
  bob = await loginAs(t, 'bob@example.com')
})
afterEach(async () => {
  await closeApp(t)
})

interface FolderBody {
  id: string
  parent_folder_id: string | null
}

async function folder(user: TestUser, name: string, parent: string | null = null): Promise<string> {
  const res = await api(t.app, user, 'POST', '/api/folders', { name, parent_folder_id: parent })
  expect(res.statusCode).toBe(201)
  return (res.json().folder as FolderBody).id
}

async function note(user: TestUser, title: string, folderId: string | null = null): Promise<string> {
  const res = await api(t.app, user, 'POST', '/api/notes', { title, folder_id: folderId })
  expect(res.statusCode).toBe(201)
  return res.json().note.id as string
}

const noteRow = (id: string) =>
  t.db.prepare('SELECT folder_id, version, title, content, updated_at FROM notes WHERE id = ?').get(id) as {
    folder_id: string | null
    version: number
    title: string
    content: string
    updated_at: number
  }

const folderParent = (id: string) =>
  t.db.prepare('SELECT parent_folder_id FROM folders WHERE id = ?').pluck().get(id) as string | null

const moveNoteReq = (user: TestUser | null, id: string, body: unknown) =>
  api(t.app, user, 'PATCH', `/api/notes/${id}/move`, body)

const moveFolderReq = (user: TestUser, id: string, body: unknown) =>
  api(t.app, user, 'PATCH', `/api/folders/${id}/move`, body)

describe('PATCH /api/notes/:id/move', () => {
  it('moves a root note into a folder', async () => {
    const work = await folder(alice, 'Work')
    const n = await note(alice, 'Plan')
    const res = await moveNoteReq(alice, n, { folder_id: work })
    expect(res.statusCode).toBe(200)
    expect(res.json().note).toMatchObject({ id: n, folder_id: work, title: 'Plan' })
    expect(res.json().note).not.toHaveProperty('content')
    expect(noteRow(n).folder_id).toBe(work)
  })

  it('moves a note to the root', async () => {
    const work = await folder(alice, 'Work')
    const n = await note(alice, 'Plan', work)
    const res = await moveNoteReq(alice, n, { folder_id: null })
    expect(res.statusCode).toBe(200)
    expect(res.json().note.folder_id).toBeNull()
    expect(noteRow(n).folder_id).toBeNull()
  })

  it('moves a note from one folder to another (including a nested one)', async () => {
    const work = await folder(alice, 'Work')
    const home = await folder(alice, 'Home')
    const deep = await folder(alice, 'Deep', home)
    const n = await note(alice, 'Plan', work)
    expect((await moveNoteReq(alice, n, { folder_id: home })).statusCode).toBe(200)
    expect(noteRow(n).folder_id).toBe(home)
    expect((await moveNoteReq(alice, n, { folder_id: deep })).statusCode).toBe(200)
    expect(noteRow(n).folder_id).toBe(deep)
  })

  it('moving into the folder it is already in succeeds and changes nothing', async () => {
    const work = await folder(alice, 'Work')
    const n = await note(alice, 'Plan', work)
    const before = noteRow(n)
    const res = await moveNoteReq(alice, n, { folder_id: work })
    expect(res.statusCode).toBe(200)
    expect(noteRow(n)).toEqual(before)
  })

  it('does not change the version, title or content, so a pending autosave still applies', async () => {
    const work = await folder(alice, 'Work')
    const n = await note(alice, 'Plan')
    const saved = await api(t.app, alice, 'PUT', `/api/notes/${n}/content`, { content: doc('v2'), version: 1 })
    expect(saved.json()).toEqual({ version: 2 })
    const before = noteRow(n)

    const res = await moveNoteReq(alice, n, { folder_id: work })
    expect(res.statusCode).toBe(200)
    expect(res.json().note.version).toBe(2)
    expect(noteRow(n)).toEqual({ ...before, folder_id: work })

    // an autosave at the pre-move version still succeeds and keeps the note where it was moved
    const after = await api(t.app, alice, 'PUT', `/api/notes/${n}/content`, { content: doc('v3'), version: 2 })
    expect(after.json()).toEqual({ version: 3 })
    expect(noteRow(n).folder_id).toBe(work)
  })

  it("rejects moving into another user's folder with 404 and leaves the note where it was", async () => {
    const bobFolder = await folder(bob, 'Bob')
    const own = await folder(alice, 'Work')
    const n = await note(alice, 'Plan', own)
    const res = await moveNoteReq(alice, n, { folder_id: bobFolder })
    expect(res.statusCode).toBe(404)
    expect(errorCode(res)).toBe('NOT_FOUND')
    expect(noteRow(n).folder_id).toBe(own)
  })

  it('rejects moving into a nonexistent folder with 404', async () => {
    const n = await note(alice, 'Plan')
    const res = await moveNoteReq(alice, n, { folder_id: randomUUID() })
    expect(res.statusCode).toBe(404)
    expect(noteRow(n).folder_id).toBeNull()
  })

  it("returns 404 for another user's note or a missing one", async () => {
    const bobNote = await note(bob, 'Bob note')
    const work = await folder(alice, 'Work')
    expect((await moveNoteReq(alice, bobNote, { folder_id: work })).statusCode).toBe(404)
    expect((await moveNoteReq(alice, bobNote, { folder_id: null })).statusCode).toBe(404)
    expect((await moveNoteReq(alice, randomUUID(), { folder_id: null })).statusCode).toBe(404)
    expect(noteRow(bobNote).folder_id).toBeNull()
  })

  it('requires folder_id (null for root) and rejects unknown fields', async () => {
    const work = await folder(alice, 'Work')
    const n = await note(alice, 'Plan', work)
    for (const body of [{}, { folder_id: work, version: 1 }, { folder_id: work, title: 'x' }, { folder_id: '' }]) {
      const res = await moveNoteReq(alice, n, body)
      expect(res.statusCode).toBe(400)
      expect(errorCode(res)).toBe('VALIDATION_ERROR')
    }
    expect(noteRow(n)).toMatchObject({ folder_id: work, title: 'Plan', version: 1 })
  })

  it('requires a session', async () => {
    const n = await note(alice, 'Plan')
    expect((await moveNoteReq(null, n, { folder_id: null })).statusCode).toBe(401)
  })
})

describe('PATCH /api/folders/:id/move', () => {
  it('moves a folder with its whole subtree of folders and notes', async () => {
    const work = await folder(alice, 'Work')
    const projects = await folder(alice, 'Projects', work)
    const deep = await folder(alice, 'Deep', projects)
    const n1 = await note(alice, 'In projects', projects)
    const n2 = await note(alice, 'In deep', deep)
    const archive = await folder(alice, 'Archive')

    const res = await moveFolderReq(alice, projects, { parent_folder_id: archive })
    expect(res.statusCode).toBe(200)
    expect(res.json().folder).toMatchObject({ id: projects, parent_folder_id: archive, name: 'Projects' })

    // the subtree travels along: its internal links are unchanged
    expect(folderParent(projects)).toBe(archive)
    expect(folderParent(deep)).toBe(projects)
    expect(noteRow(n1).folder_id).toBe(projects)
    expect(noteRow(n2).folder_id).toBe(deep)

    // the tree shows it under the new parent
    const tree = (await api(t.app, alice, 'GET', '/api/tree')).json() as { folders: FolderBody[] }
    expect(tree.folders.find((f) => f.id === projects)?.parent_folder_id).toBe(archive)
  })

  it('moves a nested folder to the root, and a root folder into another root folder', async () => {
    const work = await folder(alice, 'Work')
    const projects = await folder(alice, 'Projects', work)
    expect((await moveFolderReq(alice, projects, { parent_folder_id: null })).statusCode).toBe(200)
    expect(folderParent(projects)).toBeNull()
    expect((await moveFolderReq(alice, work, { parent_folder_id: projects })).statusCode).toBe(200)
    expect(folderParent(work)).toBe(projects)
  })

  it('moving to its current parent succeeds and changes nothing', async () => {
    const work = await folder(alice, 'Work')
    const projects = await folder(alice, 'Projects', work)
    expect((await moveFolderReq(alice, projects, { parent_folder_id: work })).statusCode).toBe(200)
    expect(folderParent(projects)).toBe(work)
  })

  it('does not change the version of notes inside the moved folder', async () => {
    const work = await folder(alice, 'Work')
    const archive = await folder(alice, 'Archive')
    const n = await note(alice, 'Plan', work)
    await api(t.app, alice, 'PUT', `/api/notes/${n}/content`, { content: doc('v2'), version: 1 })
    expect((await moveFolderReq(alice, work, { parent_folder_id: archive })).statusCode).toBe(200)
    expect(noteRow(n).version).toBe(2)
  })

  describe('cycle rejection (409)', () => {
    let a: string
    let b: string
    let c: string
    let d: string

    beforeEach(async () => {
      // a > b > c > d
      a = await folder(alice, 'A')
      b = await folder(alice, 'B', a)
      c = await folder(alice, 'C', b)
      d = await folder(alice, 'D', c)
    })

    const expectUnchanged = () => {
      expect([folderParent(a), folderParent(b), folderParent(c), folderParent(d)]).toEqual([null, a, b, c])
    }

    it('rejects moving a folder into itself', async () => {
      const res = await moveFolderReq(alice, b, { parent_folder_id: b })
      expect(res.statusCode).toBe(409)
      expect(errorCode(res)).toBe('FOLDER_CYCLE')
      expectUnchanged()
    })

    it('rejects moving a folder into its direct child', async () => {
      const res = await moveFolderReq(alice, a, { parent_folder_id: b })
      expect(res.statusCode).toBe(409)
      expect(errorCode(res)).toBe('FOLDER_CYCLE')
      expectUnchanged()
    })

    it('rejects moving a folder into a deep descendant', async () => {
      for (const [moved, target] of [
        [a, d],
        [a, c],
        [b, d],
      ] as const) {
        const res = await moveFolderReq(alice, moved, { parent_folder_id: target })
        expect(res.statusCode).toBe(409)
        expect(errorCode(res)).toBe('FOLDER_CYCLE')
      }
      expectUnchanged()
    })

    it('still allows moving a descendant up and out of the subtree', async () => {
      expect((await moveFolderReq(alice, d, { parent_folder_id: a })).statusCode).toBe(200)
      expect(folderParent(d)).toBe(a)
      // and once d is out of a's subtree... it is still under a, so a into d is still a cycle
      expect((await moveFolderReq(alice, a, { parent_folder_id: d })).statusCode).toBe(409)
      // but c (no longer an ancestor of d) can now move into d
      expect((await moveFolderReq(alice, c, { parent_folder_id: d })).statusCode).toBe(200)
      expect(folderParent(c)).toBe(d)
    })
  })

  it("rejects moving into another user's folder with 404 and leaves the folder where it was", async () => {
    const bobFolder = await folder(bob, 'Bob')
    const work = await folder(alice, 'Work')
    const res = await moveFolderReq(alice, work, { parent_folder_id: bobFolder })
    expect(res.statusCode).toBe(404)
    expect(errorCode(res)).toBe('NOT_FOUND')
    expect(folderParent(work)).toBeNull()
    expect(folderParent(bobFolder)).toBeNull()
  })

  it('rejects moving into a nonexistent folder with 404', async () => {
    const work = await folder(alice, 'Work')
    const res = await moveFolderReq(alice, work, { parent_folder_id: randomUUID() })
    expect(res.statusCode).toBe(404)
    expect(folderParent(work)).toBeNull()
  })

  it("returns 404 for another user's folder (even when the target is that folder's own child)", async () => {
    const bobFolder = await folder(bob, 'Bob')
    const bobChild = await folder(bob, 'Bob child', bobFolder)
    const work = await folder(alice, 'Work')
    expect((await moveFolderReq(alice, bobFolder, { parent_folder_id: work })).statusCode).toBe(404)
    expect((await moveFolderReq(alice, bobFolder, { parent_folder_id: null })).statusCode).toBe(404)
    // a cycle check on a foreign folder must not leak its existence as 409
    expect((await moveFolderReq(alice, bobFolder, { parent_folder_id: bobChild })).statusCode).toBe(404)
    expect((await moveFolderReq(alice, bobFolder, { parent_folder_id: bobFolder })).statusCode).toBe(404)
    expect(folderParent(bobFolder)).toBeNull()
    expect(folderParent(bobChild)).toBe(bobFolder)
  })

  it('requires parent_folder_id (null for root) and rejects unknown fields', async () => {
    const work = await folder(alice, 'Work')
    const other = await folder(alice, 'Other')
    for (const body of [{}, { parent_folder_id: other, name: 'x' }, { parent_folder_id: 5 }]) {
      const res = await moveFolderReq(alice, work, body)
      expect(res.statusCode).toBe(400)
      expect(errorCode(res)).toBe('VALIDATION_ERROR')
    }
    expect(folderParent(work)).toBeNull()
  })
})

// --- the service directly (recursive CTE) ---------------------------------------

describe('tree service', () => {
  let db: Db
  let u1: string
  let u2: string

  beforeEach(() => {
    db = openDb(':memory:')
    u1 = createUser(db, 'u1@example.com', 'hash').id
    u2 = createUser(db, 'u2@example.com', 'hash').id
  })
  afterEach(() => {
    db.close()
  })

  const mk = (userId: string, name: string, parent: string | null = null) =>
    repoCreateFolder(db, userId, { name, parentFolderId: parent })!.id

  it('isInFolderSubtree finds the folder itself and every descendant, nothing else', () => {
    const a = mk(u1, 'a')
    const b = mk(u1, 'b', a)
    const c = mk(u1, 'c', b)
    const sibling = mk(u1, 'sibling', a)
    const other = mk(u1, 'other')
    expect(isInFolderSubtree(db, u1, a, a)).toBe(true)
    expect(isInFolderSubtree(db, u1, a, b)).toBe(true)
    expect(isInFolderSubtree(db, u1, a, c)).toBe(true)
    expect(isInFolderSubtree(db, u1, a, sibling)).toBe(true)
    expect(isInFolderSubtree(db, u1, b, sibling)).toBe(false)
    expect(isInFolderSubtree(db, u1, c, a)).toBe(false)
    expect(isInFolderSubtree(db, u1, a, other)).toBe(false)
  })

  it("isInFolderSubtree never walks another user's folders", () => {
    const a = mk(u1, 'a')
    const b = mk(u1, 'b', a)
    expect(isInFolderSubtree(db, u2, a, a)).toBe(false)
    expect(isInFolderSubtree(db, u2, a, b)).toBe(false)
  })

  it('isInFolderSubtree terminates on a corrupt (already cyclic) hierarchy', () => {
    const a = mk(u1, 'a')
    const b = mk(u1, 'b', a)
    db.pragma('foreign_keys = OFF')
    db.prepare('UPDATE folders SET parent_folder_id = ? WHERE id = ?').run(b, a)
    expect(isInFolderSubtree(db, u1, a, b)).toBe(true)
    expect(isInFolderSubtree(db, u1, a, randomUUID())).toBe(false)
  })

  it('moveFolder reports not_found, target_not_found and cycle without writing', () => {
    const a = mk(u1, 'a')
    const b = mk(u1, 'b', a)
    const foreign = mk(u2, 'foreign')
    expect(moveFolder(db, u1, randomUUID(), null)).toEqual({ ok: false, reason: 'not_found' })
    expect(moveFolder(db, u1, foreign, null)).toEqual({ ok: false, reason: 'not_found' })
    expect(moveFolder(db, u1, a, foreign)).toEqual({ ok: false, reason: 'target_not_found' })
    expect(moveFolder(db, u1, a, b)).toEqual({ ok: false, reason: 'cycle' })
    expect(moveFolder(db, u1, a, a)).toEqual({ ok: false, reason: 'cycle' })
    expect(db.prepare('SELECT parent_folder_id FROM folders WHERE id = ?').pluck().get(a)).toBeNull()
    expect(moveFolder(db, u1, b, null)).toEqual({ ok: true })
  })

  it('moveNote reports not_found and target_not_found', () => {
    const own = mk(u1, 'own')
    const foreign = mk(u2, 'foreign')
    const noteId = db
      .prepare(
        "INSERT INTO notes (id, user_id, title) VALUES (lower(hex(randomblob(16))), ?, 'n') RETURNING id",
      )
      .pluck()
      .get(u1) as string
    expect(moveNote(db, u1, randomUUID(), own)).toEqual({ ok: false, reason: 'not_found' })
    expect(moveNote(db, u2, noteId, foreign)).toEqual({ ok: false, reason: 'not_found' })
    expect(moveNote(db, u1, noteId, foreign)).toEqual({ ok: false, reason: 'target_not_found' })
    expect(moveNote(db, u1, noteId, own)).toEqual({ ok: true })
    expect(moveNote(db, u1, noteId, null)).toEqual({ ok: true })
  })
})
