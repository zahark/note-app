import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'

/** A live session joined with its user. Times are unix seconds. */
export interface SessionWithUser {
  session_id: string
  user_id: string
  email: string
  is_owner: 0 | 1
  expires_at: number
}

/** Stores a session by the hash of its cookie token (the raw token is never stored). Returns the session id. */
export function createSession(db: Db, userId: string, tokenHash: string, expiresAt: number): string {
  const id = randomUUID()
  db.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    tokenHash,
    expiresAt,
  )
  return id
}

/** Returns the unexpired session for `tokenHash` (as of `nowSec`), or undefined. */
export function findSession(db: Db, tokenHash: string, nowSec: number): SessionWithUser | undefined {
  return db
    .prepare(
      `SELECT s.id AS session_id, s.user_id, u.email, u.is_owner, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(tokenHash, nowSec) as SessionWithUser | undefined
}

export function deleteSessionByTokenHash(db: Db, tokenHash: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
}

/** Removes every session that expired at or before `nowSec`. */
export function deleteExpiredSessions(db: Db, nowSec: number): number {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowSec).changes
}

/** Deletes every session of `userId`, except `keepSessionId` when given. Returns the number deleted. */
export function deleteUserSessions(db: Db, userId: string, keepSessionId?: string): number {
  if (keepSessionId === undefined) {
    return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes
  }
  return db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, keepSessionId).changes
}

export function sessionExists(db: Db, sessionId: string): boolean {
  return db.prepare('SELECT EXISTS (SELECT 1 FROM sessions WHERE id = ?)').pluck().get(sessionId) === 1
}
