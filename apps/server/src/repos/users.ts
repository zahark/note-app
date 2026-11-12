import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'

export interface UserRow {
  id: string
  email: string
  password_hash: string
  is_owner: 0 | 1
  created_at: number
}

/** Looks a user up by (already normalized) email; matching is case-insensitive (`COLLATE NOCASE`). */
export function findUserByEmail(db: Db, email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
}

export class EmailTakenError extends Error {
  constructor() {
    super('Email already registered')
    this.name = 'EmailTakenError'
  }
}

/**
 * Inserts a user. The first account ever created becomes the owner (`is_owner = 1`): the emptiness check
 * and the insert run in one IMMEDIATE transaction, and the partial unique index allows only one owner,
 * so two simultaneous first signups can never both become owner. Throws EmailTakenError on a duplicate.
 */
export function createUser(db: Db, email: string, passwordHash: string): UserRow {
  const id = randomUUID()
  const insert = db.transaction(() => {
    const isOwner = db.prepare('SELECT EXISTS (SELECT 1 FROM users)').pluck().get() === 0 ? 1 : 0
    db.prepare('INSERT INTO users (id, email, password_hash, is_owner) VALUES (?, ?, ?, ?)').run(
      id,
      email,
      passwordHash,
      isOwner,
    )
  })
  try {
    insert.immediate()
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'SQLITE_CONSTRAINT_UNIQUE' && /users\.email/.test(err.message)) {
      throw new EmailTakenError()
    }
    throw err
  }
  const user = findUserById(db, id)
  if (!user) throw new Error('user vanished after insert')
  return user
}

export function updatePasswordHash(db: Db, userId: string, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId)
}
