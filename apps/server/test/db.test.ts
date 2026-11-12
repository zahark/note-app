import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DB_FILE_NAME, openDataDb, openDb, type Db } from '../src/db/index.js'
import { loadMigrations, migrate } from '../src/db/migrate.js'

let db: Db
let tmpDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'notes-db-test-'))
  tmpDirs.push(dir)
  return dir
}

beforeEach(() => {
  db = openDb(':memory:')
})

afterEach(() => {
  if (db.open) db.close()
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

// --- fixtures ---------------------------------------------------------------

function insertUser(email = `${randomUUID()}@example.com`): string {
  const id = randomUUID()
  db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(id, email, 'hash')
  return id
}

function insertFolder(userId: string, parentId: string | null = null): string {
  const id = randomUUID()
  db.prepare('INSERT INTO folders (id, user_id, name, parent_folder_id) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    'folder',
    parentId,
  )
  return id
}

function insertNote(userId: string, folderId: string | null = null): string {
  const id = randomUUID()
  db.prepare('INSERT INTO notes (id, user_id, folder_id, title) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    folderId,
    'note',
  )
  return id
}

function insertAttachment(userId: string, storageName: string = randomUUID()): string {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO attachments (id, user_id, original_name, storage_name, mime, size)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, 'cat.png', storageName, 'image/png', 123)
  return id
}

function link(noteId: string, attachmentId: string): void {
  db.prepare('INSERT INTO note_attachments (note_id, attachment_id) VALUES (?, ?)').run(
    noteId,
    attachmentId,
  )
}

const count = (sql: string, ...params: unknown[]): number =>
  db.prepare(sql).pluck().get(...params) as number

const lastUnlinkedAt = (attachmentId: string): number | null =>
  db.prepare('SELECT last_unlinked_at FROM attachments WHERE id = ?').pluck().get(attachmentId) as
    | number
    | null

/** Backdates an attachment so a fresh trigger stamp is distinguishable from the old value. */
function clearUnlinked(attachmentId: string): void {
  db.prepare('UPDATE attachments SET last_unlinked_at = NULL WHERE id = ?').run(attachmentId)
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

// --- opener -----------------------------------------------------------------

describe('openDb', () => {
  it('enables foreign keys', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('uses WAL for file databases and creates DATA_DIR if missing', () => {
    const dataDir = path.join(tempDir(), 'nested', 'data')
    const fileDb = openDataDb(dataDir)
    try {
      expect(fileDb.name).toBe(path.join(dataDir, DB_FILE_NAME))
      expect(fileDb.pragma('journal_mode', { simple: true })).toBe('wal')
      expect(fileDb.pragma('foreign_keys', { simple: true })).toBe(1)
    } finally {
      fileDb.close()
    }
  })

  it('creates every table and the unlink trigger', () => {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .pluck()
      .all()
    expect(tables).toEqual(
      expect.arrayContaining([
        'users',
        'sessions',
        'known_devices',
        'folders',
        'notes',
        'attachments',
        'note_attachments',
        'schema_migrations',
      ]),
    )
    const trigger = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
      .pluck()
      .all()
    expect(trigger).toEqual(['note_attachments_unlinked'])
  })

  it('has no note_id column on attachments', () => {
    const cols = db
      .prepare(`SELECT name FROM pragma_table_info('attachments')`)
      .pluck()
      .all()
    expect(cols).not.toContain('note_id')
    expect(cols).toEqual(
      expect.arrayContaining(['original_name', 'storage_name', 'created_at', 'last_unlinked_at']),
    )
  })

  it('indexes user_id, parent_folder_id, folder_id and note_attachments.attachment_id', () => {
    const indexed = (table: string) =>
      db
        .prepare(
          `SELECT ii.name FROM pragma_index_list(?) il
           JOIN pragma_index_info(il.name) ii
           WHERE il.origin = 'c'`,
        )
        .pluck()
        .all(table)
    expect(indexed('folders')).toEqual(expect.arrayContaining(['user_id', 'parent_folder_id']))
    expect(indexed('notes')).toEqual(expect.arrayContaining(['user_id', 'folder_id']))
    expect(indexed('attachments')).toContain('user_id')
    expect(indexed('note_attachments')).toContain('attachment_id')
  })
})

// --- migrations -------------------------------------------------------------

describe('migrate', () => {
  it('is idempotent: a second run applies nothing and keeps the data', () => {
    const userId = insertUser()
    expect(migrate(db)).toEqual([])
    expect(count('SELECT COUNT(*) FROM users WHERE id = ?', userId)).toBe(1)
    const versions = db.prepare('SELECT version FROM schema_migrations').pluck().all()
    expect(versions).toEqual(loadMigrations().map((m) => m.version))
  })

  it('re-opening a file database does not re-run migrations', () => {
    const dataDir = tempDir()
    const first = openDataDb(dataDir)
    first.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(
      randomUUID(),
      'a@example.com',
      'h',
    )
    first.close()
    const second = openDataDb(dataDir)
    try {
      expect(second.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(1)
      expect(second.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(
        loadMigrations().length,
      )
    } finally {
      second.close()
    }
  })

  it('applies only pending migrations, in version order', () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, '002_second.sql'), 'CREATE TABLE b (id INTEGER);')
    writeFileSync(path.join(dir, '001_first.sql'), 'CREATE TABLE a (id INTEGER);')
    writeFileSync(path.join(dir, 'README.md'), 'not a migration')
    const raw = new Database(':memory:')
    try {
      expect(migrate(raw, dir)).toEqual([1, 2])
      writeFileSync(path.join(dir, '003_third.sql'), 'CREATE TABLE c (id INTEGER);')
      expect(migrate(raw, dir)).toEqual([3])
      expect(migrate(raw, dir)).toEqual([])
    } finally {
      raw.close()
    }
  })

  it('rolls back a failing migration entirely and does not record it', () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, '001_ok.sql'), 'CREATE TABLE a (id INTEGER);')
    writeFileSync(
      path.join(dir, '002_bad.sql'),
      'CREATE TABLE b (id INTEGER); INSERT INTO missing_table VALUES (1);',
    )
    const raw = new Database(':memory:')
    try {
      expect(() => migrate(raw, dir)).toThrow(/missing_table/)
      const tables = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).pluck().all()
      expect(tables).toContain('a')
      expect(tables).not.toContain('b')
      expect(raw.prepare('SELECT version FROM schema_migrations').pluck().all()).toEqual([1])
    } finally {
      raw.close()
    }
  })

  it('rejects duplicate migration versions', () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, '001_a.sql'), 'SELECT 1;')
    writeFileSync(path.join(dir, '001_b.sql'), 'SELECT 1;')
    expect(() => loadMigrations(dir)).toThrow(/Duplicate migration version 1/)
  })
})

// --- constraints ------------------------------------------------------------

describe('schema constraints', () => {
  it('enforces foreign keys', () => {
    expect(() => insertNote(randomUUID())).toThrow(/FOREIGN KEY/)
    const userId = insertUser()
    expect(() => insertFolder(userId, randomUUID())).toThrow(/FOREIGN KEY/)
    expect(() => insertNote(userId, randomUUID())).toThrow(/FOREIGN KEY/)
    expect(() => link(randomUUID(), insertAttachment(userId))).toThrow(/FOREIGN KEY/)
  })

  it('share_type CHECK rejects invalid values and defaults to private', () => {
    const noteId = insertNote(insertUser())
    expect(db.prepare('SELECT share_type FROM notes WHERE id = ?').pluck().get(noteId)).toBe(
      'private',
    )
    expect(() =>
      db.prepare(`UPDATE notes SET share_type = 'public' WHERE id = ?`).run(noteId),
    ).toThrow(/CHECK/)
    for (const t of ['password_protected', 'signed_url', 'private']) {
      db.prepare('UPDATE notes SET share_type = ? WHERE id = ?').run(t, noteId)
    }
  })

  it('notes.version defaults to 1', () => {
    const noteId = insertNote(insertUser())
    expect(db.prepare('SELECT version FROM notes WHERE id = ?').pluck().get(noteId)).toBe(1)
  })

  it('notes.content defaults to an empty TipTap doc and must be valid JSON', () => {
    const noteId = insertNote(insertUser())
    const content = db.prepare('SELECT content FROM notes WHERE id = ?').pluck().get(noteId)
    expect(JSON.parse(content as string)).toEqual({ type: 'doc', content: [] })
    expect(() =>
      db.prepare(`UPDATE notes SET content = '{not json' WHERE id = ?`).run(noteId),
    ).toThrow(/CHECK/)
  })

  it('attachments.storage_name is unique', () => {
    const userId = insertUser()
    insertAttachment(userId, 'same-name')
    expect(() => insertAttachment(userId, 'same-name')).toThrow(/UNIQUE/)
  })

  it('note_attachments primary key rejects duplicates', () => {
    const userId = insertUser()
    const noteId = insertNote(userId)
    const aid = insertAttachment(userId)
    link(noteId, aid)
    expect(() => link(noteId, aid)).toThrow(/UNIQUE|PRIMARY KEY/)
  })

  it('users.email is unique (case-insensitive)', () => {
    insertUser('Owner@Example.com')
    expect(() => insertUser('owner@example.com')).toThrow(/UNIQUE/)
  })

  it('allows at most one owner', () => {
    const a = insertUser()
    const b = insertUser()
    db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').run(a)
    expect(() => db.prepare('UPDATE users SET is_owner = 1 WHERE id = ?').run(b)).toThrow(/UNIQUE/)
    expect(count('SELECT COUNT(*) FROM users WHERE is_owner = 0')).toBe(1)
  })

  it('sessions and known_devices token hashes are unique', () => {
    const userId = insertUser()
    const insSession = db.prepare(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    )
    insSession.run(randomUUID(), userId, 't1', nowSeconds() + 60)
    expect(() => insSession.run(randomUUID(), userId, 't1', nowSeconds() + 60)).toThrow(/UNIQUE/)
    const insDevice = db.prepare(
      'INSERT INTO known_devices (id, user_id, token_hash) VALUES (?, ?, ?)',
    )
    insDevice.run(randomUUID(), userId, 'd1')
    expect(() => insDevice.run(randomUUID(), userId, 'd1')).toThrow(/UNIQUE/)
  })
})

// --- cascades ---------------------------------------------------------------

describe('cascade deletes', () => {
  it('deleting a folder cascades to child folders, notes and note_attachments but not attachments', () => {
    const userId = insertUser()
    const top = insertFolder(userId)
    const child = insertFolder(userId, top)
    const grandchild = insertFolder(userId, child)
    const noteInTop = insertNote(userId, top)
    const noteDeep = insertNote(userId, grandchild)
    const survivor = insertNote(userId)
    const aid = insertAttachment(userId)
    link(noteInTop, aid)
    link(noteDeep, aid)
    link(survivor, aid)

    db.prepare('DELETE FROM folders WHERE id = ?').run(top)

    expect(count('SELECT COUNT(*) FROM folders WHERE id IN (?, ?, ?)', top, child, grandchild)).toBe(
      0,
    )
    expect(count('SELECT COUNT(*) FROM notes WHERE id IN (?, ?)', noteInTop, noteDeep)).toBe(0)
    expect(count('SELECT COUNT(*) FROM notes WHERE id = ?', survivor)).toBe(1)
    expect(count('SELECT COUNT(*) FROM note_attachments WHERE note_id IN (?, ?)', noteInTop, noteDeep)).toBe(0)
    expect(count('SELECT COUNT(*) FROM note_attachments WHERE note_id = ?', survivor)).toBe(1)
    expect(count('SELECT COUNT(*) FROM attachments WHERE id = ?', aid)).toBe(1)
  })

  it('deleting a note removes its note_attachments rows but keeps the attachment', () => {
    const userId = insertUser()
    const noteId = insertNote(userId)
    const aid = insertAttachment(userId)
    link(noteId, aid)
    db.prepare('DELETE FROM notes WHERE id = ?').run(noteId)
    expect(count('SELECT COUNT(*) FROM note_attachments WHERE attachment_id = ?', aid)).toBe(0)
    expect(count('SELECT COUNT(*) FROM attachments WHERE id = ?', aid)).toBe(1)
  })

  it('deleting a user removes everything they own', () => {
    const userId = insertUser()
    const folder = insertFolder(userId)
    const noteId = insertNote(userId, folder)
    link(noteId, insertAttachment(userId))
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    for (const table of ['folders', 'notes', 'attachments']) {
      expect(count(`SELECT COUNT(*) FROM ${table} WHERE user_id = ?`, userId)).toBe(0)
    }
    expect(count('SELECT COUNT(*) FROM note_attachments')).toBe(0)
  })
})

// --- note_attachments_unlinked trigger --------------------------------------

describe('note_attachments_unlinked trigger', () => {
  it('a new attachment starts with last_unlinked_at NULL; inserting a link leaves it NULL', () => {
    const userId = insertUser()
    const aid = insertAttachment(userId)
    expect(lastUnlinkedAt(aid)).toBeNull()
    link(insertNote(userId), aid)
    expect(lastUnlinkedAt(aid)).toBeNull()
  })

  it('stamps last_unlinked_at on an explicit note_attachments delete', () => {
    const userId = insertUser()
    const noteId = insertNote(userId)
    const aid = insertAttachment(userId)
    link(noteId, aid)
    const before = nowSeconds()
    db.prepare('DELETE FROM note_attachments WHERE note_id = ? AND attachment_id = ?').run(
      noteId,
      aid,
    )
    const stamped = lastUnlinkedAt(aid)
    expect(stamped).not.toBeNull()
    expect(stamped).toBeGreaterThanOrEqual(before)
    expect(stamped).toBeLessThanOrEqual(nowSeconds())
  })

  it('stamps last_unlinked_at when the note is deleted', () => {
    const userId = insertUser()
    const noteId = insertNote(userId)
    const aid = insertAttachment(userId)
    link(noteId, aid)
    clearUnlinked(aid)
    const before = nowSeconds()
    db.prepare('DELETE FROM notes WHERE id = ?').run(noteId)
    expect(lastUnlinkedAt(aid)).toBeGreaterThanOrEqual(before)
  })

  it('stamps last_unlinked_at when a grandparent folder of the note is deleted (two-level cascade)', () => {
    const userId = insertUser()
    const grandparent = insertFolder(userId)
    const parent = insertFolder(userId, grandparent)
    const noteId = insertNote(userId, parent)
    const aid = insertAttachment(userId)
    link(noteId, aid)
    clearUnlinked(aid)
    const before = nowSeconds()
    db.prepare('DELETE FROM folders WHERE id = ?').run(grandparent)
    expect(count('SELECT COUNT(*) FROM note_attachments WHERE attachment_id = ?', aid)).toBe(0)
    expect(lastUnlinkedAt(aid)).toBeGreaterThanOrEqual(before)
  })

  it('only stamps the attachment whose link was removed', () => {
    const userId = insertUser()
    const noteId = insertNote(userId)
    const removed = insertAttachment(userId)
    const kept = insertAttachment(userId)
    link(noteId, removed)
    link(noteId, kept)
    db.prepare('DELETE FROM note_attachments WHERE attachment_id = ?').run(removed)
    expect(lastUnlinkedAt(removed)).not.toBeNull()
    expect(lastUnlinkedAt(kept)).toBeNull()
  })
})
