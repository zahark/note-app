import { randomBytes } from 'node:crypto'
import argon2 from 'argon2'
import { badRequest } from '../errors.js'
import { HashLimiter, type HashRunOptions } from './hashLimiter.js'

export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_MAX_LENGTH = 256

/**
 * The single password policy, shared by signup, change-password and the reset CLI.
 * Length is counted in Unicode code points. Returns an error message, or null when acceptable.
 */
export function validatePassword(password: string): string | null {
  const length = [...password].length
  if (length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`
  }
  return null
}

/** Throws a 400 WEAK_PASSWORD when `password` violates the policy. */
export function assertValidPassword(password: string): void {
  const problem = validatePassword(password)
  if (problem) throw badRequest(problem, 'WEAK_PASSWORD')
}

/** Raw password hashing primitive; injectable so tests can count calls and control timing. */
export interface PasswordHasher {
  hash(password: string): Promise<string>
  verify(hash: string, password: string): Promise<boolean>
}

/** argon2id with the library defaults (m=64 MiB, t=3, p=4). */
export const argon2Hasher: PasswordHasher = {
  hash: (password) => argon2.hash(password, { type: argon2.argon2id }),
  verify: async (hash, password) => {
    try {
      return await argon2.verify(hash, password)
    } catch {
      // a malformed stored hash is a failed verification, not a crash
      return false
    }
  },
}

/**
 * All password hashing goes through here, so every argon2 call is behind the global concurrency cap.
 * `reserved` marks owner-on-a-known-device work that may use the reserved slot (see HashLimiter).
 */
export class PasswordService {
  private dummyHash: Promise<string> | undefined

  constructor(
    private readonly hasher: PasswordHasher,
    private readonly limiter: HashLimiter,
  ) {}

  hash(password: string, opts: HashRunOptions = {}): Promise<string> {
    return this.limiter.run(() => this.hasher.hash(password), opts)
  }

  /**
   * Verifies `password` against `hash`. With `hash === null` (unknown account) it runs a dummy verify of
   * the same cost and returns false, so unknown emails take the same time as wrong passwords.
   */
  verify(hash: string | null, password: string, opts: HashRunOptions = {}): Promise<boolean> {
    return this.limiter.run(async () => {
      if (hash !== null) return this.hasher.verify(hash, password)
      this.dummyHash ??= this.hasher.hash(randomBytes(16).toString('hex'))
      await this.hasher.verify(await this.dummyHash, password)
      return false
    }, opts)
  }
}
