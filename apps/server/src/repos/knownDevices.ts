import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'

export interface KnownDeviceRow {
  id: string
  user_id: string
  token_hash: string
  created_at: number
  last_used_at: number
}

/** Stores a device by the hash of its cookie value (the raw value is never stored). Returns the row id. */
export function createKnownDevice(db: Db, userId: string, tokenHash: string, nowSec: number): string {
  const id = randomUUID()
  db.prepare(
    'INSERT INTO known_devices (id, user_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, userId, tokenHash, nowSec, nowSec)
  return id
}

export function findKnownDevice(db: Db, tokenHash: string): KnownDeviceRow | undefined {
  return db.prepare('SELECT * FROM known_devices WHERE token_hash = ?').get(tokenHash) as
    | KnownDeviceRow
    | undefined
}

export function touchKnownDevice(db: Db, id: string, nowSec: number): void {
  db.prepare('UPDATE known_devices SET last_used_at = ? WHERE id = ?').run(nowSec, id)
}

/** Forgets every known device of `userId` (after a password change or reset). Returns the number deleted. */
export function deleteUserKnownDevices(db: Db, userId: string): number {
  return db.prepare('DELETE FROM known_devices WHERE user_id = ?').run(userId).changes
}
