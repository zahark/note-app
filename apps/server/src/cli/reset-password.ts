// `npm run reset-password -- <email>`: sets a new password for an account from the server's shell.
// Needs only DATA_DIR (not the secrets): it rewrites the hash and revokes every session and known device.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DB_FILE_NAME, openDb, type Db } from '../db/index.js'
import { deleteUserKnownDevices } from '../repos/knownDevices.js'
import { deleteUserSessions } from '../repos/sessions.js'
import { findUserByEmail, updatePasswordHash } from '../repos/users.js'
import { normalizeEmail } from '../services/auth.js'
import { argon2Hasher, validatePassword, type PasswordHasher } from '../services/password.js'
import { CliError, cliDataDir, runIfInvokedDirectly } from './common.js'

/**
 * Core of the CLI (exported for tests): validates `password` with the shared policy, stores its hash for
 * the account `email`, and deletes all of that user's sessions and known devices in one transaction.
 */
export async function resetPassword(
  db: Db,
  email: string,
  password: string,
  hasher: PasswordHasher = argon2Hasher,
): Promise<void> {
  const problem = validatePassword(password)
  if (problem) throw new CliError(problem)
  const normalized = normalizeEmail(email)
  if (!findUserByEmail(db, normalized)) throw new CliError(`No account with email ${normalized}`)

  const hash = await hasher.hash(password)
  db.transaction(() => {
    // looked up again inside the transaction in case the account changed while hashing
    const user = findUserByEmail(db, normalized)
    if (!user) throw new CliError(`No account with email ${normalized}`)
    updatePasswordHash(db, user.id, hash)
    deleteUserSessions(db, user.id)
    deleteUserKnownDevices(db, user.id)
  }).immediate()
}

/** Reads one line from a TTY without echoing it. */
function promptHidden(question: string): Promise<string> {
  const input = process.stdin
  process.stderr.write(question)
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (err?: Error) => {
      input.setRawMode(false)
      input.pause()
      input.off('data', onData)
      process.stderr.write('\n')
      if (err) reject(err)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish()
        if (ch === '\u0003' || ch === '\u0004') return finish(new CliError('Aborted'))
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('')
        else value += ch
      }
    }
    input.setEncoding('utf8')
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

/** Reads all of stdin (non-interactive use, e.g. a pipe) and returns its first line. */
async function readFirstLine(): Promise<string> {
  let data = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) data += chunk as string
  return data.split(/\r?\n/)[0] ?? ''
}

async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readFirstLine()
  const password = await promptHidden('New password: ')
  const again = await promptHidden('Repeat new password: ')
  if (password !== again) throw new CliError('Passwords do not match')
  return password
}

async function main(args: string[]): Promise<void> {
  const email = args[0]
  if (!email || args.length > 1) {
    throw new CliError('Usage: npm run reset-password -- <email>')
  }
  const dbPath = path.join(cliDataDir(), DB_FILE_NAME)
  if (!existsSync(dbPath)) throw new CliError(`No database at ${dbPath} (check DATA_DIR)`)

  const password = await readNewPassword()
  const db = openDb(dbPath)
  try {
    await resetPassword(db, email, password)
  } finally {
    db.close()
  }
  console.log(`Password reset for ${normalizeEmail(email)}; all of its sessions and known devices were revoked.`)
}

runIfInvokedDirectly(import.meta.url, main)
