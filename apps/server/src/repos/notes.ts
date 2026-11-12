// Owner-scoped note queries: every function takes the caller's userId and only ever matches that
// user's rows, so another user's note is indistinguishable from a missing one (routes answer 404).
// `share_secret` is never selected here.
import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'
import { ownsNote } from './access.js'
import { requireUserId } from './scope.js'

export type ShareType = 'private' | 'password_protected' | 'signed_url'

/** A note without its content (what the tree needs). */
export interface NoteSummary {
  id: string
  user_id: string
  /** NULL = root. */
  folder_id: string | null
  title: string
  version: number
  created_at: number
  updated_at: number
  share_type: ShareType
  expires_at: number | null
}

export interface Note extends NoteSummary {
  /** Parsed TipTap JSON document. */
  content: unknown
}

export interface NewNote {
  /** NULL = root; otherwise must be a folder owned by the same user. */
  folderId: string | null
  title?: string
}

export type SaveContentResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'not_found' | 'conflict' }

const SUMMARY_COLUMNS =
  'id, user_id, folder_id, title, version, created_at, updated_at, share_type, expires_at'

type NoteRow = NoteSummary & { content: string }

export function listNoteSummaries(db: Db, userId: string): NoteSummary[] {
  requireUserId(userId)
  return db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM notes WHERE user_id = ? ORDER BY created_at, id`)
    .all(userId) as NoteSummary[]
}

export function getNoteSummary(db: Db, userId: string, noteId: string): NoteSummary | undefined {
  requireUserId(userId)
  return db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM notes WHERE id = ? AND user_id = ?`)
    .get(noteId, userId) as NoteSummary | undefined
}

export function getNote(db: Db, userId: string, noteId: string): Note | undefined {
  requireUserId(userId)
  const row = db
    .prepare(`SELECT ${SUMMARY_COLUMNS}, content FROM notes WHERE id = ? AND user_id = ?`)
    .get(noteId, userId) as NoteRow | undefined
  return row && { ...row, content: JSON.parse(row.content) as unknown }
}

/**
 * Creates an empty note. Returns undefined, inserting nothing, when `folderId` is not a folder of
 * `userId` (another user's or missing). The ownership check and the insert are one statement.
 */
export function createNote(db: Db, userId: string, input: NewNote): Note | undefined {
  requireUserId(userId)
  const id = randomUUID()
  const { changes } = db
    .prepare(
      `INSERT INTO notes (id, user_id, folder_id, title)
       SELECT @id, @userId, @folder, @title
        WHERE @folder IS NULL
           OR EXISTS (SELECT 1 FROM folders WHERE id = @folder AND user_id = @userId)`,
    )
    .run({ id, userId, folder: input.folderId, title: input.title ?? '' })
  return changes === 1 ? getNote(db, userId, id) : undefined
}

/** Changes the title only; `version` is untouched so a rename never conflicts with autosave. */
export function renameNote(db: Db, userId: string, noteId: string, title: string): boolean {
  requireUserId(userId)
  return (
    db
      .prepare('UPDATE notes SET title = ?, updated_at = unixepoch() WHERE id = ? AND user_id = ?')
      .run(title, noteId, userId).changes === 1
  )
}

/**
 * Optimistic-concurrency content save: writes only when the stored `version` equals
 * `expectedVersion`, then increments it. `not_found` covers another user's note too.
 * Run it inside the caller's transaction (`saveContentWithAttachments` syncs the note's attachment
 * references in the same IMMEDIATE transaction).
 */
export function saveNoteContent(
  db: Db,
  userId: string,
  noteId: string,
  content: unknown,
  expectedVersion: number,
): SaveContentResult {
  requireUserId(userId)
  const updated = db
    .prepare(
      `UPDATE notes SET content = ?, version = version + 1, updated_at = unixepoch()
        WHERE id = ? AND user_id = ? AND version = ?
        RETURNING version`,
    )
    .pluck()
    .get(JSON.stringify(content), noteId, userId, expectedVersion) as number | undefined
  if (updated !== undefined) return { ok: true, version: updated }
  return { ok: false, reason: ownsNote(db, userId, noteId) ? 'conflict' : 'not_found' }
}

/** Deletes the note (its attachment references cascade). Returns false when not the caller's. */
export function deleteNote(db: Db, userId: string, noteId: string): boolean {
  requireUserId(userId)
  return db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(noteId, userId).changes === 1
}

/**
 * Moves a note to another folder (NULL = root). Neither `version` nor `updated_at` changes, so a move
 * never conflicts with autosave. Returns false, changing nothing, when the note is not the caller's or
 * `folderId` is not a folder of the caller (checked in the same statement).
 */
export function updateNoteFolder(db: Db, userId: string, noteId: string, folderId: string | null): boolean {
  requireUserId(userId)
  return (
    db
      .prepare(
        `UPDATE notes SET folder_id = @folder
          WHERE id = @id AND user_id = @userId
            AND (@folder IS NULL
                 OR EXISTS (SELECT 1 FROM folders WHERE id = @folder AND user_id = @userId))`,
      )
      .run({ id: noteId, userId, folder: folderId }).changes === 1
  )
}

/** A note's sharing settings, as stored on the note row. */
export interface ShareSettings {
  type: ShareType
  /** argon2 hash of the PIN (`password_protected`), the signing nonce (`signed_url`), or null (`private`). */
  secret: string | null
  /** Unix seconds when a signed link expires; null for PIN shares and private notes. */
  expiresAt: number | null
}

/**
 * Replaces the note's sharing settings. Neither `version` nor `updated_at` changes (sharing is not a
 * content edit). Returns false, changing nothing, when the note is not the caller's.
 */
export function updateNoteShare(db: Db, userId: string, noteId: string, share: ShareSettings): boolean {
  requireUserId(userId)
  return (
    db
      .prepare(
        `UPDATE notes SET share_type = @type, share_secret = @secret, expires_at = @expiresAt
          WHERE id = @id AND user_id = @userId`,
      )
      .run({ id: noteId, userId, type: share.type, secret: share.secret, expiresAt: share.expiresAt })
      .changes === 1
  )
}
