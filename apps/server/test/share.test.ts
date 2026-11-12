// Sharing: PIN shares (PIN shown once, only an argon2 hash stored, tokens bound to the current PIN),
// signed expiring links (HMAC over note_id|exp|nonce, 30-day cap, nonce rotation revokes), stopping,
// and owner scoping of the share endpoints.
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db/index.js'
import { AppError } from '../src/errors.js'
import { createNote } from '../src/repos/notes.js'
import { createUser } from '../src/repos/users.js'
import { HashLimiter } from '../src/services/hashLimiter.js'
import { argon2Hasher, PasswordService } from '../src/services/password.js'
import {
  generatePin,
  MAX_SIGNED_TTL_SEC,
  PIN_ALPHABET,
  PIN_LENGTH,
  SHARE_TOKEN_TTL_SEC,
  ShareService,
  signLink,
} from '../src/services/share.js'
import { closeApp, errorCode, makeApp, ORIGIN, testConfig, type TestApp } from './helpers/auth.js'
import { api, loginAs, type TestUser } from './helpers/api.js'

const HMAC_KEY = 'b'.repeat(32) // SHARE_HMAC_KEY in testConfig
const PIN_RE = new RegExp(`^[${PIN_ALPHABET}]{${PIN_LENGTH}}$`)

let t: TestApp
let alice: TestUser
let bob: TestUser
let noteId: string

beforeEach(async () => {
  t = await makeApp()
  alice = await loginAs(t, 'alice@example.com')
  bob = await loginAs(t, 'bob@example.com')
  const res = await api(t.app, alice, 'POST', '/api/notes', { title: 'Shared' })
  noteId = res.json().note.id
})

afterEach(async () => {
  await closeApp(t)
})

const nowSec = () => Math.floor(t.clock.t / 1000)

interface ShareRow {
  share_type: string
  share_secret: string | null
  expires_at: number | null
  version: number
}
const row = (id = noteId) =>
  t.db.prepare('SELECT share_type, share_secret, expires_at, version FROM notes WHERE id = ?').get(id) as ShareRow

async function sharePin(user: TestUser = alice, id = noteId): Promise<string> {
  const res = await api(t.app, user, 'POST', `/api/notes/${id}/share`, { type: 'password_protected' })
  expect(res.statusCode).toBe(200)
  return res.json().share.pin
}

async function shareSigned(expires_in = '1d', id = noteId) {
  const res = await api(t.app, alice, 'POST', `/api/notes/${id}/share`, { type: 'signed_url', expires_in })
  expect(res.statusCode).toBe(200)
  return res.json().share as { type: string; exp: number; sig: string; url: string }
}

const unlock = (pin: string, id = noteId, ip = '203.0.113.7') => t.app.share.unlock({ noteId: id, pin, ip })

/** The error code an unlock rejects with. */
async function unlockError(pin: string, id = noteId): Promise<string> {
  try {
    await unlock(pin, id)
  } catch (err) {
    if (err instanceof AppError) return err.code
    throw err
  }
  throw new Error('unlock unexpectedly succeeded')
}

describe('generatePin', () => {
  it('draws 8 characters from the unambiguous alphabet, differently each time', () => {
    const pins = new Set(Array.from({ length: 200 }, generatePin))
    for (const pin of pins) expect(pin).toMatch(PIN_RE)
    expect(pins.size).toBe(200)
    for (const lookAlike of ['0', 'O', '1', 'I']) expect(PIN_ALPHABET).not.toContain(lookAlike)
  })
})

describe('password share', () => {
  it('returns an 8-char PIN once and stores only its hash', async () => {
    const pin = await sharePin()
    expect(pin).toMatch(PIN_RE)
    const r = row()
    expect(r.share_type).toBe('password_protected')
    expect(r.share_secret).toBe(`fake$${pin}`) // what the (fake) password hasher produced
    expect(r.expires_at).toBeNull()

    // never shown again: the note payloads carry neither the PIN nor its hash
    const note = await api(t.app, alice, 'GET', `/api/notes/${noteId}`)
    expect(note.json().note.share_type).toBe('password_protected')
    expect(note.body).not.toContain(pin)
    expect(note.body).not.toContain('share_secret')
    const tree = await api(t.app, alice, 'GET', '/api/tree')
    expect(tree.body).not.toContain(pin)
  })

  it('stores a real argon2id hash in production', async () => {
    const db = openDb(':memory:')
    try {
      const userId = createUser(db, 'carol@example.com', 'x').id
      const note = createNote(db, userId, { folderId: null })!
      const share = new ShareService({
        db,
        config: testConfig(),
        passwords: new PasswordService(argon2Hasher, new HashLimiter()),
      })
      const { pin } = await share.enablePin(userId, note.id)
      const secret = db.prepare('SELECT share_secret FROM notes WHERE id = ?').pluck().get(note.id) as string
      expect(secret).toMatch(/^\$argon2id\$/)
      expect(secret).not.toContain(pin)
      const { token } = await share.unlock({ noteId: note.id, pin, ip: '198.51.100.1' })
      expect(share.verifyToken(note.id, token)).toBe(true)
    } finally {
      db.close()
    }
  })

  it('unlocks with the PIN (any case, surrounding spaces ignored) into a 30-minute token', async () => {
    const pin = await sharePin()
    const { token, expiresAt } = await unlock(` ${pin.toLowerCase()} `)
    expect(expiresAt).toBe(nowSec() + SHARE_TOKEN_TTL_SEC)
    expect(t.app.share.verifyToken(noteId, token)).toBe(true)

    t.clock.advance(SHARE_TOKEN_TTL_SEC * 1000 - 1000)
    expect(t.app.share.verifyToken(noteId, token)).toBe(true)
    t.clock.advance(1000)
    expect(t.app.share.verifyToken(noteId, token)).toBe(false)
  })

  it('rejects a wrong PIN, tampered tokens and tokens for another note', async () => {
    const pin = await sharePin()
    expect(await unlockError('WRONGPIN')).toBe('UNAVAILABLE')

    const { token } = await unlock(pin)
    const [exp, mac] = token.split('.') as [string, string]
    const flipped = mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A')
    for (const bad of [`${exp}.${flipped}`, `${Number(exp) + 3600}.${mac}`, mac, '', `${exp}.`, `x${token}`]) {
      expect(t.app.share.verifyToken(noteId, bad)).toBe(false)
    }
    expect(t.app.share.verifyToken(noteId, undefined)).toBe(false)

    const other = (await api(t.app, alice, 'POST', '/api/notes', { title: 'Other' })).json().note.id
    await sharePin(alice, other)
    expect(t.app.share.verifyToken(other, token)).toBe(false)
  })

  it('regenerating invalidates the old PIN and every token issued for it', async () => {
    const oldPin = await sharePin()
    const { token: oldToken } = await unlock(oldPin)

    const newPin = await sharePin()
    expect(newPin).not.toBe(oldPin)
    expect(t.app.share.verifyToken(noteId, oldToken)).toBe(false)
    expect(await unlockError(oldPin)).toBe('UNAVAILABLE')

    const { token } = await unlock(newPin)
    expect(t.app.share.verifyToken(noteId, token)).toBe(true)
  })

  it('stopping resets the note to private and revokes the PIN and its tokens', async () => {
    const pin = await sharePin()
    const { token } = await unlock(pin)

    const res = await api(t.app, alice, 'DELETE', `/api/notes/${noteId}/share`)
    expect(res.statusCode).toBe(204)
    expect(row()).toMatchObject({ share_type: 'private', share_secret: null, expires_at: null })
    expect(t.app.share.verifyToken(noteId, token)).toBe(false)
    expect(await unlockError(pin)).toBe('UNAVAILABLE')
  })

  it.each([
    ['regenerated', () => sharePin()],
    ['stopped', () => api(t.app, alice, 'DELETE', `/api/notes/${noteId}/share`)],
  ])('a correct-PIN unlock still verifying fails when the share is %s meanwhile', async (_, change) => {
    const pin = await sharePin()
    t.hasher.blocked.add(pin)
    const outcome = unlock(pin).then(
      (r) => r,
      (err: unknown) => (err instanceof AppError ? err.code : err),
    )
    await vi.waitFor(() => expect(t.hasher.active).toBe(1))
    await change()
    t.hasher.release()
    // no token is minted (it would be bound to the new PIN's hash and unlock the re-shared note)
    expect(await outcome).toBe('UNAVAILABLE')
  })

  it('a token from a PIN share does not survive switching the note to a signed link', async () => {
    const pin = await sharePin()
    const { token } = await unlock(pin)
    await shareSigned()
    expect(t.app.share.verifyToken(noteId, token)).toBe(false)
    expect(await unlockError(pin)).toBe('UNAVAILABLE')
  })

  it('sharing never changes the content version', async () => {
    await sharePin()
    await shareSigned()
    await api(t.app, alice, 'DELETE', `/api/notes/${noteId}/share`)
    expect(row().version).toBe(1)
  })
})

describe('signed link share', () => {
  it('builds exp + sig = HMAC-SHA256(SHARE_HMAC_KEY, note_id|exp|nonce) and a link to the shared page', async () => {
    const share = await shareSigned('1d')
    const r = row()
    expect(share.type).toBe('signed_url')
    expect(share.exp).toBe(nowSec() + 24 * 3600)
    expect(r).toMatchObject({ share_type: 'signed_url', expires_at: share.exp })
    const nonce = r.share_secret!
    expect(nonce.length).toBeGreaterThanOrEqual(16)

    const expected = createHmac('sha256', HMAC_KEY).update(`${noteId}|${share.exp}|${nonce}`).digest('base64url')
    expect(share.sig).toBe(expected)
    expect(signLink(HMAC_KEY, noteId, share.exp, nonce)).toBe(expected)

    const url = new URL(share.url)
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toBe(`/shared/${noteId}`)
    expect(url.searchParams.get('exp')).toBe(String(share.exp))
    expect(url.searchParams.get('sig')).toBe(share.sig)
    expect(t.app.share.verifySignedLink(noteId, String(share.exp), share.sig)).toBe(true)
  })

  it.each([
    ['1h', 3600],
    ['1d', 86400],
    ['7d', 7 * 86400],
    ['30d', 30 * 86400],
  ])('offers %s', async (option, seconds) => {
    expect((await shareSigned(option)).exp).toBe(nowSec() + seconds)
  })

  it('stops working once expired', async () => {
    const { exp, sig } = await shareSigned('1h')
    t.clock.advance(3600 * 1000 - 1000)
    expect(t.app.share.verifySignedLink(noteId, String(exp), sig)).toBe(true)
    t.clock.advance(1000)
    expect(t.app.share.verifySignedLink(noteId, String(exp), sig)).toBe(false)
  })

  it('rejects a tampered sig or exp, malformed params, and another note id', async () => {
    const { exp, sig } = await shareSigned('1h')
    const v = (id: string, e: string | undefined, s: string | undefined) => t.app.share.verifySignedLink(id, e, s)
    expect(v(noteId, String(exp), sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A'))).toBe(false)
    expect(v(noteId, String(exp + 86400), sig)).toBe(false)
    expect(v(noteId, `${exp}.0`, sig)).toBe(false)
    expect(v(noteId, `+${exp}`, sig)).toBe(false)
    expect(v(noteId, undefined, sig)).toBe(false)
    expect(v(noteId, String(exp), undefined)).toBe(false)
    expect(v(noteId, String(exp), '')).toBe(false)

    const other = (await api(t.app, alice, 'POST', '/api/notes', { title: 'Other' })).json().note.id
    await shareSigned('1h', other)
    expect(v(other, String(exp), sig)).toBe(false)
  })

  it('enforces the 30-day maximum', async () => {
    for (const expires_in of ['60d', '31d', '2h', 2592001, 3600]) {
      const res = await api(t.app, alice, 'POST', `/api/notes/${noteId}/share`, { type: 'signed_url', expires_in })
      expect(res.statusCode).toBe(400)
      expect(errorCode(res)).toBe('VALIDATION_ERROR')
    }
    const missing = await api(t.app, alice, 'POST', `/api/notes/${noteId}/share`, { type: 'signed_url' })
    expect(missing.statusCode).toBe(400)

    // the service enforces the cap too, independently of the route's fixed options
    for (const ttl of [MAX_SIGNED_TTL_SEC + 1, 0, -1, 1.5]) {
      expect(() => t.app.share.enableSigned(alice.id, noteId, ttl)).toThrow(
        expect.objectContaining({ statusCode: 400, code: 'INVALID_EXPIRY' }),
      )
    }
    expect(t.app.share.enableSigned(alice.id, noteId, MAX_SIGNED_TTL_SEC).exp).toBe(nowSec() + MAX_SIGNED_TTL_SEC)
    expect(row().share_type).toBe('signed_url')
  })

  it('regenerating rotates the nonce, so the old link fails and the new one works', async () => {
    const old = await shareSigned('7d')
    const oldNonce = row().share_secret
    const fresh = await shareSigned('7d')
    expect(row().share_secret).not.toBe(oldNonce)
    expect(t.app.share.verifySignedLink(noteId, String(old.exp), old.sig)).toBe(false)
    expect(t.app.share.verifySignedLink(noteId, String(fresh.exp), fresh.sig)).toBe(true)
  })

  it('stopping (or switching to a PIN share) revokes the link', async () => {
    const link = await shareSigned('7d')
    const res = await api(t.app, alice, 'DELETE', `/api/notes/${noteId}/share`)
    expect(res.statusCode).toBe(204)
    expect(row()).toMatchObject({ share_type: 'private', share_secret: null, expires_at: null })
    expect(t.app.share.verifySignedLink(noteId, String(link.exp), link.sig)).toBe(false)

    const again = await shareSigned('7d')
    await sharePin()
    expect(t.app.share.verifySignedLink(noteId, String(again.exp), again.sig)).toBe(false)
  })
})

describe('share endpoints', () => {
  it("user B cannot enable, regenerate or stop A's share; A's PIN keeps working", async () => {
    const pin = await sharePin()
    const before = row()
    const hashesBefore = t.hasher.hashCalls

    for (const body of [{ type: 'password_protected' }, { type: 'signed_url', expires_in: '1d' }]) {
      const res = await api(t.app, bob, 'POST', `/api/notes/${noteId}/share`, body)
      expect(res.statusCode).toBe(404)
      expect(errorCode(res)).toBe('NOT_FOUND')
    }
    const del = await api(t.app, bob, 'DELETE', `/api/notes/${noteId}/share`)
    expect(del.statusCode).toBe(404)

    expect(row()).toEqual(before)
    expect(t.hasher.hashCalls).toBe(hashesBefore) // no PIN hashing for someone else's note
    const { token } = await unlock(pin)
    expect(t.app.share.verifyToken(noteId, token)).toBe(true)
  })

  it('answers 404 for a missing note and 401 without a session', async () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    expect((await api(t.app, alice, 'POST', `/api/notes/${missing}/share`, { type: 'password_protected' })).statusCode).toBe(404)
    expect((await api(t.app, alice, 'DELETE', `/api/notes/${missing}/share`)).statusCode).toBe(404)
    expect((await api(t.app, null, 'POST', `/api/notes/${noteId}/share`, { type: 'password_protected' })).statusCode).toBe(401)
    expect((await api(t.app, null, 'DELETE', `/api/notes/${noteId}/share`)).statusCode).toBe(401)
    expect(row().share_type).toBe('private')
  })

  it('rejects an unknown share type or extra fields', async () => {
    for (const body of [{}, { type: 'public' }, { type: 'password_protected', pin: '12345678' }]) {
      const res = await api(t.app, alice, 'POST', `/api/notes/${noteId}/share`, body)
      expect(res.statusCode).toBe(400)
    }
    expect(row().share_type).toBe('private')
  })
})
