import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db/index.js'
import * as accessRepo from '../src/repos/access.js'
import { resolveAccess } from '../src/repos/access.js'
import * as attachmentsRepo from '../src/repos/attachments.js'
import {
  createAttachment,
  getAttachment,
  setNoteAttachments,
} from '../src/repos/attachments.js'
import * as foldersRepo from '../src/repos/folders.js'
import {
  createFolder,
  deleteFolder,
  getFolder,
  listFolders,
  renameFolder,
  updateFolderParent,
} from '../src/repos/folders.js'
import * as notesRepo from '../src/repos/notes.js'
import {
  createNote,
  deleteNote,
  getNote,
  getNoteSummary,
  listNoteSummaries,
  renameNote,
  saveNoteContent,
  updateNoteFolder,
  updateNoteShare,
} from '../src/repos/notes.js'
import { MissingUserIdError } from '../src/repos/scope.js'
import { createUser } from '../src/repos/users.js'

let db: Db
let alice: string
let bob: string

beforeEach(() => {
  db = openDb(':memory:')
  alice = createUser(db, 'alice@example.com', 'hash').id
  bob = createUser(db, 'bob@example.com', 'hash').id
})

afterEach(() => {
  db.close()
})

/** Ids of the attachments linked to `noteId`, sorted. */
const linkedIds = (noteId: string): string[] =>
  db.prepare('SELECT attachment_id FROM note_attachments WHERE note_id = ? ORDER BY attachment_id').pluck().all(noteId) as string[]

const count = (sql: string, ...params: unknown[]): number =>
  db.prepare(sql).pluck().get(...params) as number

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

function newAttachment(userId: string) {
  return createAttachment(db, userId, {
    originalName: 'cat.png',
    storageName: randomUUID(),
    mime: 'image/png',
    size: 123,
  })
}

// --- every function is owner-scoped ------------------------------------------

/** The owner-scoped repos. `publicShare.ts` (Task 9) is the only unscoped repo and is not listed here. */
const scopedRepos = {
  folders: foldersRepo,
  notes: notesRepo,
  attachments: attachmentsRepo,
  access: accessRepo,
} as const

const scopedFunctions = Object.entries(scopedRepos).flatMap(([repo, mod]) =>
  Object.entries(mod)
    .filter((entry): entry is [string, (...args: unknown[]) => unknown] => typeof entry[1] === 'function')
    .map(([name, fn]) => [`${repo}.${name}`, fn] as const),
)

describe('owner-scoped repos require a userId', () => {
  it('discovers the repo functions', () => {
    expect(scopedFunctions.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'folders.createFolder',
        'folders.getFolder',
        'folders.listFolders',
        'folders.renameFolder',
        'folders.deleteFolder',
        'folders.updateFolderParent',
        'notes.createNote',
        'notes.getNote',
        'notes.getNoteSummary',
        'notes.listNoteSummaries',
        'notes.renameNote',
        'notes.saveNoteContent',
        'notes.deleteNote',
        'notes.updateNoteFolder',
        'notes.updateNoteShare',
        'attachments.createAttachment',
        'attachments.getAttachment',
        'attachments.setNoteAttachments',
        'access.resolveAccess',
      ]),
    )
  })

  it.each(scopedFunctions)('%s takes userId as its second parameter', (_name, fn) => {
    expect(fn.length).toBeGreaterThanOrEqual(2)
  })

  it.each(scopedFunctions)('%s throws without a userId and touches nothing', (_name, fn) => {
    const folder = createFolder(db, alice, { name: 'A', parentFolderId: null })!
    const note = createNote(db, alice, { folderId: null, title: 'A' })!
    const before = {
      folders: count('SELECT COUNT(*) FROM folders'),
      notes: count('SELECT COUNT(*) FROM notes'),
      attachments: count('SELECT COUNT(*) FROM attachments'),
    }
    // Plausible arguments after the missing userId, so only the scope check can reject the call.
    const rest = [note.id, 'renamed', 1]
    for (const missing of ['', undefined, null]) {
      expect(() => fn(db, missing, ...rest)).toThrow(MissingUserIdError)
      expect(() => fn(db, missing, folder.id, 'renamed')).toThrow(MissingUserIdError)
    }
    expect({
      folders: count('SELECT COUNT(*) FROM folders'),
      notes: count('SELECT COUNT(*) FROM notes'),
      attachments: count('SELECT COUNT(*) FROM attachments'),
    }).toEqual(before)
    expect(getNote(db, alice, note.id)?.title).toBe('A')
    expect(getFolder(db, alice, folder.id)?.name).toBe('A')
  })
})

// --- folders -------------------------------------------------------------------

describe('folders repo', () => {
  it('creates root and nested folders and lists only the caller’s', () => {
    const root = createFolder(db, alice, { name: 'Work', parentFolderId: null })!
    expect(root).toMatchObject({ user_id: alice, name: 'Work', parent_folder_id: null })
    expect(root.id).toMatch(/^[0-9a-f-]{36}$/)
    const child = createFolder(db, alice, { name: 'Projects', parentFolderId: root.id })!
    expect(child.parent_folder_id).toBe(root.id)
    createFolder(db, bob, { name: 'Bob stuff', parentFolderId: null })

    expect(listFolders(db, alice).map((f) => f.name).sort()).toEqual(['Projects', 'Work'])
    expect(listFolders(db, bob).map((f) => f.name)).toEqual(['Bob stuff'])
  })

  it('refuses a parent folder owned by another user or missing, inserting nothing', () => {
    const aliceFolder = createFolder(db, alice, { name: 'A', parentFolderId: null })!
    expect(createFolder(db, bob, { name: 'sneaky', parentFolderId: aliceFolder.id })).toBeUndefined()
    expect(createFolder(db, bob, { name: 'ghost', parentFolderId: randomUUID() })).toBeUndefined()
    expect(count('SELECT COUNT(*) FROM folders WHERE user_id = ?', bob)).toBe(0)
  })

  it('renames and deletes only the caller’s folder', () => {
    const folder = createFolder(db, alice, { name: 'A', parentFolderId: null })!

    expect(getFolder(db, bob, folder.id)).toBeUndefined()
    expect(renameFolder(db, bob, folder.id, 'pwned')).toBe(false)
    expect(deleteFolder(db, bob, folder.id)).toBe(false)
    expect(getFolder(db, alice, folder.id)?.name).toBe('A')

    expect(renameFolder(db, alice, folder.id, 'B')).toBe(true)
    expect(getFolder(db, alice, folder.id)?.name).toBe('B')
    expect(deleteFolder(db, alice, folder.id)).toBe(true)
    expect(getFolder(db, alice, folder.id)).toBeUndefined()
  })

  it('reports a missing folder as not found', () => {
    const id = randomUUID()
    expect(getFolder(db, alice, id)).toBeUndefined()
    expect(renameFolder(db, alice, id, 'x')).toBe(false)
    expect(deleteFolder(db, alice, id)).toBe(false)
  })

  it('deleting a folder removes its subtree', () => {
    const top = createFolder(db, alice, { name: 'top', parentFolderId: null })!
    const mid = createFolder(db, alice, { name: 'mid', parentFolderId: top.id })!
    const note = createNote(db, alice, { folderId: mid.id, title: 'deep' })!
    expect(deleteFolder(db, alice, top.id)).toBe(true)
    expect(getFolder(db, alice, mid.id)).toBeUndefined()
    expect(getNote(db, alice, note.id)).toBeUndefined()
  })

  it('re-parents only the caller’s folder, and only under the caller’s folder or the root', () => {
    const a = createFolder(db, alice, { name: 'a', parentFolderId: null })!
    const b = createFolder(db, alice, { name: 'b', parentFolderId: null })!
    const bobs = createFolder(db, bob, { name: 'bob', parentFolderId: null })!
    expect(updateFolderParent(db, alice, b.id, a.id)).toBe(true)
    expect(getFolder(db, alice, b.id)?.parent_folder_id).toBe(a.id)
    expect(updateFolderParent(db, alice, b.id, null)).toBe(true)
    expect(getFolder(db, alice, b.id)?.parent_folder_id).toBeNull()

    expect(updateFolderParent(db, alice, b.id, bobs.id)).toBe(false)
    expect(updateFolderParent(db, alice, b.id, randomUUID())).toBe(false)
    expect(updateFolderParent(db, bob, b.id, null)).toBe(false)
    expect(updateFolderParent(db, bob, a.id, bobs.id)).toBe(false)
    expect(getFolder(db, alice, b.id)?.parent_folder_id).toBeNull()
    expect(getFolder(db, alice, a.id)?.parent_folder_id).toBeNull()
  })
})

// --- notes ---------------------------------------------------------------------

describe('notes repo', () => {
  it('creates a note at the root or in an own folder with defaults', () => {
    const atRoot = createNote(db, alice, { folderId: null })!
    expect(atRoot).toMatchObject({
      user_id: alice,
      folder_id: null,
      title: '',
      version: 1,
      share_type: 'private',
      content: { type: 'doc', content: [] },
    })
    const folder = createFolder(db, alice, { name: 'F', parentFolderId: null })!
    const inFolder = createNote(db, alice, { folderId: folder.id, title: 'Hello' })!
    expect(inFolder).toMatchObject({ folder_id: folder.id, title: 'Hello' })
  })

  it('never exposes the share secret', () => {
    const note = createNote(db, alice, { folderId: null })!
    db.prepare(`UPDATE notes SET share_secret = 'secret' WHERE id = ?`).run(note.id)
    expect(getNote(db, alice, note.id)).not.toHaveProperty('share_secret')
    expect(getNoteSummary(db, alice, note.id)).not.toHaveProperty('share_secret')
    expect(listNoteSummaries(db, alice)[0]).not.toHaveProperty('share_secret')
  })

  it('refuses a folder owned by another user or missing, inserting nothing', () => {
    const aliceFolder = createFolder(db, alice, { name: 'A', parentFolderId: null })!
    expect(createNote(db, bob, { folderId: aliceFolder.id, title: 'sneaky' })).toBeUndefined()
    expect(createNote(db, bob, { folderId: randomUUID(), title: 'ghost' })).toBeUndefined()
    expect(count('SELECT COUNT(*) FROM notes WHERE user_id = ?', bob)).toBe(0)
  })

  it('lists only the caller’s notes, without content', () => {
    createNote(db, alice, { folderId: null, title: 'A1' })
    createNote(db, alice, { folderId: null, title: 'A2' })
    createNote(db, bob, { folderId: null, title: 'B1' })
    const mine = listNoteSummaries(db, alice)
    expect(mine.map((n) => n.title).sort()).toEqual(['A1', 'A2'])
    for (const n of mine) expect(n).not.toHaveProperty('content')
    expect(getNoteSummary(db, alice, mine[0]!.id)).toEqual(mine[0])
    expect(listNoteSummaries(db, bob).map((n) => n.title)).toEqual(['B1'])
  })

  it('saves content with a matching version and returns version + 1', () => {
    const note = createNote(db, alice, { folderId: null })!
    expect(saveNoteContent(db, alice, note.id, doc('one'), 1)).toEqual({ ok: true, version: 2 })
    expect(saveNoteContent(db, alice, note.id, doc('two'), 2)).toEqual({ ok: true, version: 3 })
    expect(getNote(db, alice, note.id)).toMatchObject({ version: 3, content: doc('two') })
  })

  it('rejects a stale version as a conflict without writing', () => {
    const note = createNote(db, alice, { folderId: null })!
    saveNoteContent(db, alice, note.id, doc('one'), 1)
    expect(saveNoteContent(db, alice, note.id, doc('stale'), 1)).toEqual({ ok: false, reason: 'conflict' })
    expect(getNote(db, alice, note.id)).toMatchObject({ version: 2, content: doc('one') })
  })

  it('renaming leaves the version alone, so a save at the old version keeps the new title', () => {
    const note = createNote(db, alice, { folderId: null, title: 'old' })!
    expect(renameNote(db, alice, note.id, 'new')).toBe(true)
    expect(getNote(db, alice, note.id)).toMatchObject({ title: 'new', version: 1 })
    expect(saveNoteContent(db, alice, note.id, doc('body'), 1)).toEqual({ ok: true, version: 2 })
    expect(getNote(db, alice, note.id)).toMatchObject({ title: 'new', version: 2 })
  })

  it('user B cannot read, rename, save or delete user A’s note', () => {
    const note = createNote(db, alice, { folderId: null, title: 'private' })!
    saveNoteContent(db, alice, note.id, doc('secret'), 1)

    expect(getNote(db, bob, note.id)).toBeUndefined()
    expect(getNoteSummary(db, bob, note.id)).toBeUndefined()
    expect(renameNote(db, bob, note.id, 'pwned')).toBe(false)
    expect(saveNoteContent(db, bob, note.id, doc('pwned'), 2)).toEqual({ ok: false, reason: 'not_found' })
    expect(saveNoteContent(db, bob, note.id, doc('pwned'), 1)).toEqual({ ok: false, reason: 'not_found' })
    expect(deleteNote(db, bob, note.id)).toBe(false)

    expect(getNote(db, alice, note.id)).toMatchObject({ title: 'private', version: 2, content: doc('secret') })
  })

  it('moves only the caller’s note, only into the caller’s folder or the root, keeping version', () => {
    const own = createFolder(db, alice, { name: 'own', parentFolderId: null })!
    const bobs = createFolder(db, bob, { name: 'bob', parentFolderId: null })!
    const note = createNote(db, alice, { folderId: null, title: 'n' })!
    saveNoteContent(db, alice, note.id, doc('v2'), 1)

    expect(updateNoteFolder(db, alice, note.id, own.id)).toBe(true)
    expect(getNote(db, alice, note.id)).toMatchObject({ folder_id: own.id, version: 2 })
    expect(updateNoteFolder(db, alice, note.id, bobs.id)).toBe(false)
    expect(updateNoteFolder(db, alice, note.id, randomUUID())).toBe(false)
    expect(updateNoteFolder(db, bob, note.id, null)).toBe(false)
    expect(updateNoteFolder(db, bob, note.id, bobs.id)).toBe(false)
    expect(getNote(db, alice, note.id)?.folder_id).toBe(own.id)
    expect(updateNoteFolder(db, alice, note.id, null)).toBe(true)
    expect(getNote(db, alice, note.id)).toMatchObject({ folder_id: null, version: 2 })
  })

  it('reports a missing note as not found', () => {
    const id = randomUUID()
    expect(getNote(db, alice, id)).toBeUndefined()
    expect(getNoteSummary(db, alice, id)).toBeUndefined()
    expect(renameNote(db, alice, id, 'x')).toBe(false)
    expect(saveNoteContent(db, alice, id, doc('x'), 1)).toEqual({ ok: false, reason: 'not_found' })
    expect(deleteNote(db, alice, id)).toBe(false)
  })

  it('deletes the caller’s note', () => {
    const note = createNote(db, alice, { folderId: null })!
    expect(deleteNote(db, alice, note.id)).toBe(true)
    expect(getNote(db, alice, note.id)).toBeUndefined()
  })

  it('updates only the caller’s share settings, leaving version and updated_at alone', () => {
    const note = createNote(db, alice, { folderId: null })!
    const shareRow = () =>
      db.prepare('SELECT share_type, share_secret, expires_at, version, updated_at FROM notes WHERE id = ?').get(note.id)
    const before = shareRow()
    const signed = { type: 'signed_url', secret: 'nonce', expiresAt: 2_000_000_000 } as const
    expect(updateNoteShare(db, bob, note.id, signed)).toBe(false)
    expect(updateNoteShare(db, alice, randomUUID(), signed)).toBe(false)
    expect(shareRow()).toEqual(before)

    expect(updateNoteShare(db, alice, note.id, signed)).toBe(true)
    expect(shareRow()).toEqual({
      share_type: 'signed_url',
      share_secret: 'nonce',
      expires_at: 2_000_000_000,
      version: note.version,
      updated_at: note.updated_at,
    })
    expect(updateNoteShare(db, alice, note.id, { type: 'private', secret: null, expiresAt: null })).toBe(true)
    expect(shareRow()).toMatchObject({ share_type: 'private', share_secret: null, expires_at: null })
  })
})

// --- attachments ---------------------------------------------------------------

describe('attachments repo', () => {
  it('creates an attachment owned by the caller with no unlink stamp', () => {
    const att = newAttachment(alice)
    expect(att).toMatchObject({
      user_id: alice,
      original_name: 'cat.png',
      mime: 'image/png',
      size: 123,
      last_unlinked_at: null,
    })
    expect(getAttachment(db, alice, att.id)).toEqual(att)
  })

  it('user B cannot read user A’s attachment; a missing id is not found', () => {
    const att = newAttachment(alice)
    expect(getAttachment(db, bob, att.id)).toBeUndefined()
    expect(getAttachment(db, alice, randomUUID())).toBeUndefined()
  })

  it('setNoteAttachments makes the links equal the given set, keeping only the caller’s attachments', () => {
    const [a, b, c] = [newAttachment(alice), newAttachment(alice), newAttachment(alice)]
    const foreign = newAttachment(bob)
    const note = createNote(db, alice, { folderId: null })!
    expect(setNoteAttachments(db, alice, note.id, [a.id, b.id, foreign.id, randomUUID()])).toBe(true)
    expect(linkedIds(note.id)).toEqual([a.id, b.id].sort())

    expect(setNoteAttachments(db, alice, note.id, [b.id, c.id, c.id])).toBe(true)
    expect(linkedIds(note.id)).toEqual([b.id, c.id].sort())
    // the dropped link was stamped by the trigger; the kept ones were not
    expect(getAttachment(db, alice, a.id)?.last_unlinked_at).not.toBeNull()
    expect(getAttachment(db, alice, b.id)?.last_unlinked_at).toBeNull()
  })

  it('setNoteAttachments on another user’s or a missing note changes nothing', () => {
    const own = newAttachment(bob)
    const att = newAttachment(alice)
    const note = createNote(db, alice, { folderId: null })!
    setNoteAttachments(db, alice, note.id, [att.id])
    expect(setNoteAttachments(db, bob, note.id, [own.id])).toBe(false)
    expect(setNoteAttachments(db, bob, note.id, [])).toBe(false)
    expect(setNoteAttachments(db, alice, randomUUID(), [att.id])).toBe(false)
    expect(linkedIds(note.id)).toEqual([att.id])
    expect(count('SELECT COUNT(*) FROM note_attachments')).toBe(1)
  })
})

// --- access resolution ---------------------------------------------------------

describe('resolveAccess', () => {
  it('returns owner for the caller’s own note', () => {
    const note = createNote(db, alice, { folderId: null })!
    expect(resolveAccess(db, alice, note.id)).toBe('owner')
  })

  it('returns none for another user’s note and for a missing note', () => {
    const note = createNote(db, alice, { folderId: null })!
    expect(resolveAccess(db, bob, note.id)).toBe('none')
    expect(resolveAccess(db, alice, randomUUID())).toBe('none')
  })

  it('returns none once the note is deleted', () => {
    const note = createNote(db, alice, { folderId: null })!
    deleteNote(db, alice, note.id)
    expect(resolveAccess(db, alice, note.id)).toBe('none')
  })
})
