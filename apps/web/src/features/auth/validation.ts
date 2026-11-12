/** Client-side mirror of the server's single password policy (apps/server/src/services/password.ts). */
export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_MAX_LENGTH = 256

/** Returns an error message, or null when acceptable. Length is counted in Unicode code points. */
export function validatePassword(password: string): string | null {
  const length = [...password].length
  if (length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`
  if (length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`
  return null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateEmail(email: string): string | null {
  const trimmed = email.trim()
  if (!trimmed) return 'Email is required'
  if (trimmed.length > 254 || !EMAIL_RE.test(trimmed)) return 'Enter a valid email address'
  return null
}
