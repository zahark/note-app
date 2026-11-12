/**
 * Thrown when an owner-scoped repo function is called without a userId. Every query in the
 * owner-scoped repos (folders, notes, attachments, access) is filtered by `user_id`; this runtime
 * check backs up the type system so an unscoped call fails loudly instead of matching nothing (or
 * everything). The only unscoped module is `publicShare.ts`.
 */
export class MissingUserIdError extends Error {
  constructor() {
    super('owner-scoped repo called without a userId')
    this.name = 'MissingUserIdError'
  }
}

/** Throws MissingUserIdError unless `userId` is a non-empty string. Call it first in every scoped repo function. */
export function requireUserId(userId: string): void {
  if (typeof userId !== 'string' || userId.length === 0) throw new MissingUserIdError()
}
