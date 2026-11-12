// The reset-password CLI end to end, as an operator runs it: a separate process with DATA_DIR in its
// environment, the email as the only argument and the new password piped on stdin (non-TTY: the first
// line is the password). Uses real argon2.
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DB_FILE_NAME, openDb } from '../src/db/index.js'
import { createKnownDevice } from '../src/repos/knownDevices.js'
import { createSession } from '../src/repos/sessions.js'
import { argon2Hasher } from '../src/services/password.js'
import { seedUser } from './helpers/auth.js'
import { tmpDataDir } from './helpers/api.js'

const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))
const TSX = path.join(SERVER_DIR, '../../node_modules/.bin/tsx')
const CLI = path.join(SERVER_DIR, 'src/cli/reset-password.ts')
const NEW_PASSWORD = 'a brand new passphrase'

let dataDir: string
let userId: string

beforeEach(() => {
  dataDir = tmpDataDir()
  const db = openDb(path.join(dataDir, DB_FILE_NAME))
  userId = seedUser(db, 'alice@example.com')
  createSession(db, userId, 'session-hash', 2_000_000_000)
  createKnownDevice(db, userId, 'device-hash', 1_800_000_000)
  db.close()
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function runCli(args: string[], stdin: string, env: Record<string, string> = { DATA_DIR: dataDir }) {
  const res = spawnSync(TSX, [CLI, ...args], {
    cwd: SERVER_DIR,
    input: stdin,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
    timeout: 30_000,
  })
  return { status: res.status, stdout: res.stdout, stderr: res.stderr }
}

function readUser() {
  const db = openDb(path.join(dataDir, DB_FILE_NAME))
  try {
    return {
      hash: db.prepare('SELECT password_hash FROM users WHERE id = ?').pluck().get(userId) as string,
      sessions: db.prepare('SELECT COUNT(*) FROM sessions').pluck().get() as number,
      devices: db.prepare('SELECT COUNT(*) FROM known_devices').pluck().get() as number,
    }
  } finally {
    db.close()
  }
}

describe('reset-password CLI', () => {
  it('reads the first stdin line as the password, stores its argon2id hash, revokes sessions/devices, exits 0', async () => {
    const res = runCli(['  Alice@Example.com '], `${NEW_PASSWORD}\nignored second line\n`)
    expect(res.stderr).toBe('')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Password reset for alice@example.com')
    const after = readUser()
    expect(after.hash).toMatch(/^\$argon2id\$/)
    expect(await argon2Hasher.verify(after.hash, NEW_PASSWORD)).toBe(true)
    expect(after).toMatchObject({ sessions: 0, devices: 0 })
  }, 30_000)

  it.each([
    ['an unknown email', ['nobody@example.com'], `${NEW_PASSWORD}\n`, 'No account with email nobody@example.com'],
    ['a weak password', ['alice@example.com'], 'short\n', 'Password must be at least 10 characters'],
    ['no email argument', [], `${NEW_PASSWORD}\n`, 'Usage: npm run reset-password -- <email>'],
    ['two arguments', ['alice@example.com', 'extra'], `${NEW_PASSWORD}\n`, 'Usage: npm run reset-password -- <email>'],
  ])('%s: exits 1 with the message and changes nothing', (_name, args, stdin, message) => {
    const res = runCli(args, stdin)
    expect(res.status).toBe(1)
    expect(res.stderr.trim()).toBe(message)
    expect(readUser()).toEqual({ hash: 'fake$correct horse battery', sessions: 1, devices: 1 })
  }, 30_000)

  it('exits 1 when DATA_DIR holds no database', () => {
    const empty = tmpDataDir()
    try {
      const res = runCli(['alice@example.com'], `${NEW_PASSWORD}\n`, { DATA_DIR: empty })
      expect(res.status).toBe(1)
      expect(res.stderr).toContain(`No database at ${path.join(empty, DB_FILE_NAME)}`)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  }, 30_000)
})
