// The public shared API over HTTP: PIN unlock → token (Authorization header only), signed links
// (exp/sig query params), the identical "unavailable" failure, privacy headers, a payload limited to
// title + content + linked attachment ids, and attachments served only through `note_attachments`.
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import path from 'node:path'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { uploadsDir } from '../src/services/attachments.js'
import { SHARE_TOKEN_TTL_SEC } from '../src/services/share.js'
import { closeApp, errorCode, makeApp, ORIGIN, type TestApp } from './helpers/auth.js'
import {
  api,
  doc,
  docWithFiles,
  docWithImages,
  GPX,
  loginAs,
  PDF,
  PNG,
  tmpDataDir,
  uploadFile,
  uploadPng,
  type TestUser,
} from './helpers/api.js'

let dataDir: string
let t: TestApp
let alice: TestUser
let bob: TestUser
/** Alice's note, with `aid` in its content. */
let noteId: string
let aid: string

beforeEach(async () => {
  dataDir = tmpDataDir()
  t = await makeApp({ env: { DATA_DIR: dataDir } })
  alice = await loginAs(t, 'alice@example.com')
  bob = await loginAs(t, 'bob@example.com')
  aid = await uploadPng(t.app, alice)
  noteId = await newNote('Shared', docWithImages(aid))
})

afterEach(async () => {
  await closeApp(t)
  rmSync(dataDir, { recursive: true, force: true })
})

const nowSec = () => Math.floor(t.clock.t / 1000)

/** Creates a note of `user` and saves `content` into it. */
async function newNote(title: string, content: unknown = doc('hi'), user: TestUser = alice): Promise<string> {
  const id = (await api(t.app, user, 'POST', '/api/notes', { title })).json().note.id as string
  await saveContent(id, content, user)
  return id
}

async function saveContent(id: string, content: unknown, user: TestUser = alice): Promise<void> {
  const { version } = (await api(t.app, user, 'GET', `/api/notes/${id}`)).json().note
  const res = await api(t.app, user, 'PUT', `/api/notes/${id}/content`, { content, version })
  expect(res.statusCode).toBe(200)
}

async function sharePin(id = noteId): Promise<string> {
  const res = await api(t.app, alice, 'POST', `/api/notes/${id}/share`, { type: 'password_protected' })
  expect(res.statusCode).toBe(200)
  return res.json().share.pin
}

async function shareSigned(id = noteId, expires_in = '1d'): Promise<{ exp: number; sig: string }> {
  const res = await api(t.app, alice, 'POST', `/api/notes/${id}/share`, { type: 'signed_url', expires_in })
  expect(res.statusCode).toBe(200)
  return res.json().share
}

const stopSharing = (id = noteId) => api(t.app, alice, 'DELETE', `/api/notes/${id}/share`)

interface PublicRequest {
  token?: string
  /** Raw Authorization header (overrides `token`). */
  authorization?: string
  query?: Record<string, string | number>
  cookies?: Record<string, string>
  ip?: string
}

function unlockReq(id: string, pin: unknown, r: PublicRequest = {}): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'POST',
    url: `/api/shared/${id}/unlock`,
    remoteAddress: r.ip ?? '203.0.113.7',
    headers: { origin: ORIGIN },
    cookies: r.cookies ?? {},
    payload: { pin },
  })
}

function publicGet(url: string, r: PublicRequest = {}): Promise<LightMyRequestResponse> {
  const authorization = r.authorization ?? (r.token === undefined ? undefined : `Bearer ${r.token}`)
  const query = r.query ? `?${new URLSearchParams(Object.entries(r.query).map(([k, v]): [string, string] => [k, String(v)]))}` : ''
  return t.app.inject({
    method: 'GET',
    url: `${url}${query}`,
    headers: authorization === undefined ? {} : { authorization },
    cookies: r.cookies ?? {},
  })
}

const getShared = (id: string, r?: PublicRequest) => publicGet(`/api/shared/${id}`, r)
const getSharedImage = (id: string, attachmentId: string, r?: PublicRequest) =>
  publicGet(`/api/shared/${id}/attachments/${attachmentId}`, r)

async function unlock(id = noteId, pin?: string): Promise<string> {
  const res = await unlockReq(id, pin ?? (await sharePin(id)))
  expect(res.statusCode).toBe(200)
  return res.json().token
}

/** The one failure response of the shared surface. */
function expectUnavailable(res: LightMyRequestResponse): void {
  expect(res.statusCode).toBe(404)
  expect(errorCode(res)).toBe('UNAVAILABLE')
}

const linkQuery = (link: { exp: number; sig: string }) => ({ exp: link.exp, sig: link.sig })

describe('PIN share', () => {
  it('unlocking with the correct PIN returns a 30-minute token', async () => {
    const pin = await sharePin()
    const res = await unlockReq(noteId, pin)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Object.keys(body).sort()).toEqual(['expires_at', 'token'])
    expect(body.expires_at).toBe(nowSec() + SHARE_TOKEN_TTL_SEC)
    expect(body.token).toMatch(/^\d+\.[A-Za-z0-9_-]+$/)
  })

  it('the token grants the note and its attachments', async () => {
    const token = await unlock()
    const note = await getShared(noteId, { token })
    expect(note.statusCode).toBe(200)
    expect(note.json()).toEqual({ note: { title: 'Shared', content: docWithImages(aid), attachment_ids: [aid] } })

    const image = await getSharedImage(noteId, aid, { token })
    expect(image.statusCode).toBe(200)
    expect(image.headers['content-type']).toBe('image/png')
    expect(image.headers['x-content-type-options']).toBe('nosniff')
    expect(image.rawPayload.equals(PNG)).toBe(true)
  })

  it('rejects a tampered, malformed or missing token', async () => {
    const token = await unlock()
    const [exp, mac] = token.split('.') as [string, string]
    const flipped = `${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`
    const bad: PublicRequest[] = [
      { token: `${exp}.${flipped}` },
      { token: `${Number(exp) + 60}.${mac}` },
      { token: mac },
      { token: '' },
      { authorization: token }, // no Bearer scheme
      { authorization: `Basic ${token}` },
      {},
    ]
    for (const r of bad) {
      expectUnavailable(await getShared(noteId, r))
      expectUnavailable(await getSharedImage(noteId, aid, r))
    }
  })

  it('rejects an expired token', async () => {
    const token = await unlock()
    t.clock.advance((SHARE_TOKEN_TTL_SEC - 1) * 1000)
    expect((await getShared(noteId, { token })).statusCode).toBe(200)
    t.clock.advance(1000)
    expectUnavailable(await getShared(noteId, { token }))
    expectUnavailable(await getSharedImage(noteId, aid, { token }))
  })

  it("a token for one note does not open another PIN-shared note", async () => {
    const other = await newNote('Other')
    await sharePin(other)
    const token = await unlock()
    expectUnavailable(await getShared(other, { token }))
  })

  it('regenerating or stopping the share revokes issued tokens', async () => {
    const token = await unlock()
    await sharePin()
    expectUnavailable(await getShared(noteId, { token }))

    const second = await unlock()
    expect((await stopSharing()).statusCode).toBe(204)
    expectUnavailable(await getShared(noteId, { token: second }))
  })

  it('locks the id after 5 wrong PINs (429 even for the right PIN), for a nonexistent id the same way', async () => {
    const pin = await sharePin()
    const missing = randomUUID()
    for (const id of [noteId, missing]) {
      for (let i = 0; i < 5; i++) expectUnavailable(await unlockReq(id, 'ZZZZZZZZ', { ip: `198.51.100.${i}` }))
      const locked = await unlockReq(id, id === noteId ? pin : 'ZZZZZZZZ')
      expect(locked.statusCode).toBe(429)
      expect(errorCode(locked)).toBe('RATE_LIMITED')
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0)
    }
  })

  it('unlock is a mutating request: it needs the exact Origin, and a malformed body is a 400', async () => {
    const pin = await sharePin()
    const noOrigin = await t.app.inject({ method: 'POST', url: `/api/shared/${noteId}/unlock`, payload: { pin } })
    expect(noOrigin.statusCode).toBe(403)
    for (const payload of [{}, { pin: '' }, { pin: 12345678 }, { pin, extra: 1 }]) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/shared/${noteId}/unlock`,
        headers: { origin: ORIGIN },
        payload,
      })
      expect(res.statusCode).toBe(400)
    }
  })
})

describe('signed link', () => {
  it('a valid link returns the content', async () => {
    const link = await shareSigned()
    const res = await getShared(noteId, { query: linkQuery(link) })
    expect(res.statusCode).toBe(200)
    expect(res.json().note).toEqual({ title: 'Shared', content: docWithImages(aid), attachment_ids: [aid] })
  })

  it("a valid link's exp/sig as query params on the attachment URL return the image bytes", async () => {
    const link = await shareSigned()
    const res = await getSharedImage(noteId, aid, { query: linkQuery(link) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.rawPayload.equals(PNG)).toBe(true)
  })

  it('rejects a tampered sig, an altered exp, a missing param and another note id', async () => {
    const link = await shareSigned()
    const other = await newNote('Other')
    await shareSigned(other)
    const flipped = `${link.sig.slice(0, -1)}${link.sig.endsWith('A') ? 'B' : 'A'}`
    const cases: Array<[string, PublicRequest]> = [
      [noteId, { query: { exp: link.exp, sig: flipped } }],
      [noteId, { query: { exp: link.exp + 3600, sig: link.sig } }],
      [noteId, { query: { exp: link.exp } }],
      [noteId, { query: { sig: link.sig } }],
      [noteId, { query: { exp: `${link.exp}.0`, sig: link.sig } }],
      [other, { query: linkQuery(link) }],
    ]
    for (const [id, r] of cases) {
      expectUnavailable(await getShared(id, r))
      expectUnavailable(await getSharedImage(id, aid, r))
    }
  })

  it('rejects an expired link', async () => {
    const link = await shareSigned(noteId, '1h')
    t.clock.advance((3600 - 1) * 1000)
    expect((await getShared(noteId, { query: linkQuery(link) })).statusCode).toBe(200)
    t.clock.advance(1000)
    expectUnavailable(await getShared(noteId, { query: linkQuery(link) }))
    expectUnavailable(await getSharedImage(noteId, aid, { query: linkQuery(link) }))
  })

  it('regenerating rotates the nonce: the old link fails, the new one works', async () => {
    const old = await shareSigned()
    const fresh = await shareSigned()
    expectUnavailable(await getShared(noteId, { query: linkQuery(old) }))
    expect((await getShared(noteId, { query: linkQuery(fresh) })).statusCode).toBe(200)
  })

  it('a link stops working when the share type changes or sharing stops', async () => {
    const link = await shareSigned()
    await sharePin()
    expectUnavailable(await getShared(noteId, { query: linkQuery(link) }))

    const second = await shareSigned()
    await stopSharing()
    expectUnavailable(await getShared(noteId, { query: linkQuery(second) }))
  })
})

describe('the unavailable response', () => {
  it('is byte-identical for wrong PIN, expired, revoked, private and nonexistent notes', async () => {
    const pin = await sharePin()
    const responses: Record<string, LightMyRequestResponse> = {}

    responses['wrong PIN'] = await unlockReq(noteId, pin === 'ZZZZZZZZ' ? 'YYYYYYYY' : 'ZZZZZZZZ')
    responses['wrong PIN on a link-shared note'] = await unlockReq(
      await (async () => {
        const id = await newNote('linked')
        await shareSigned(id)
        return id
      })(),
      pin,
    )
    responses['unlock a nonexistent note'] = await unlockReq(randomUUID(), pin)
    const priv = await newNote('private')
    responses['unlock a private note'] = await unlockReq(priv, pin)

    const token = await unlock(noteId, pin)
    t.clock.advance((SHARE_TOKEN_TTL_SEC + 1) * 1000)
    responses['expired token'] = await getShared(noteId, { token })

    const expiring = await newNote('expiring')
    const link = await shareSigned(expiring, '1h')
    t.clock.advance(3601 * 1000)
    responses['expired link'] = await getShared(expiring, { query: linkQuery(link) })

    const revokedId = await newNote('revoked')
    const revokedLink = await shareSigned(revokedId)
    await stopSharing(revokedId)
    responses['revoked link'] = await getShared(revokedId, { query: linkQuery(revokedLink) })
    responses['revoked link, attachment'] = await getSharedImage(revokedId, aid, { query: linkQuery(revokedLink) })

    responses['private note'] = await getShared(priv)
    responses['nonexistent note'] = await getShared(randomUUID())
    responses['nonexistent note, attachment'] = await getSharedImage(randomUUID(), randomUUID())
    responses['non-UUID id'] = await getShared('x'.repeat(100))
    // over the router's 100-char param limit: still the identical response, not Fastify's own 414
    responses['101-char id'] = await getShared('x'.repeat(101))
    responses['150-char id'] = await getShared('x'.repeat(150))
    responses['150-char id, attachment'] = await getSharedImage('x'.repeat(150), aid)

    const reference = responses['nonexistent note']!
    expect(reference.statusCode).toBe(404)
    for (const [name, res] of Object.entries(responses)) {
      expect({ name, status: res.statusCode, body: res.body, type: res.headers['content-type'] }).toEqual({
        name,
        status: 404,
        body: reference.body,
        type: reference.headers['content-type'],
      })
    }
    expect(reference.json()).toEqual({ error: { code: 'UNAVAILABLE', message: expect.any(String) } })
  })

  it('never consults the session cookie', async () => {
    // the owner's own session does not open their private note on the shared surface...
    const priv = await newNote('private')
    expectUnavailable(await getShared(priv, { cookies: { sid: alice.sid } }))
    expectUnavailable(await getSharedImage(noteId, aid, { cookies: { sid: alice.sid } }))
    // ...and an unrelated (or garbage) session does not stop a valid token from working
    const token = await unlock()
    expect((await getShared(noteId, { token, cookies: { sid: bob.sid } })).statusCode).toBe(200)
    expect((await getShared(noteId, { token, cookies: { sid: 'garbage' } })).statusCode).toBe(200)
    const pin = await sharePin()
    expect((await unlockReq(noteId, pin, { cookies: { sid: 'garbage' } })).statusCode).toBe(200)
  })

  it('every shared API response carries no-referrer, noindex and no-store', async () => {
    const pin = await sharePin()
    const token = await unlock(noteId, pin)
    const responses = [
      await unlockReq(noteId, pin),
      await getShared(noteId, { token }),
      await getSharedImage(noteId, aid, { token }),
      await getShared(randomUUID()),
      await unlockReq(noteId, ''),
      await publicGet('/api/shared/a/b/c/d'),
      await publicGet('/api/shared'),
      await getShared('x'.repeat(150)),
    ]
    for (let i = 0; i < 5; i++) await unlockReq(noteId, 'ZZZZZZZZ', { ip: `198.51.100.${i}` })
    const locked = await unlockReq(noteId, pin)
    expect(locked.statusCode).toBe(429)
    responses.push(locked)

    for (const res of responses) {
      expect(res.headers['referrer-policy']).toBe('no-referrer')
      expect(res.headers['x-robots-tag']).toBe('noindex')
      expect(res.headers['cache-control']).toBe('no-store')
    }
  })

  it('does not add those headers to the private API', async () => {
    const res = await api(t.app, alice, 'GET', '/api/tree')
    expect(res.headers['x-robots-tag']).toBeUndefined()
  })
})

describe('payload', () => {
  it('contains only title, content and the linked attachment ids', async () => {
    const token = await unlock()
    const res = await getShared(noteId, { token })
    expect(Object.keys(res.json())).toEqual(['note'])
    expect(Object.keys(res.json().note).sort()).toEqual(['attachment_ids', 'content', 'title'])
    for (const secret of [alice.id, 'share_secret', 'user_id', 'version', 'folder_id']) {
      expect(res.body).not.toContain(secret)
    }
  })

  it("lists only attachments linked through note_attachments (not unknown or another user's ids in the content)", async () => {
    const bobs = await uploadPng(t.app, bob)
    const unknown = randomUUID()
    await saveContent(noteId, docWithImages(aid, bobs, unknown))
    const token = await unlock()
    const res = await getShared(noteId, { token })
    expect(res.json().note.attachment_ids).toEqual([aid])
    expectUnavailable(await getSharedImage(noteId, bobs, { token }))
    expectUnavailable(await getSharedImage(noteId, unknown, { token }))
  })
})

describe('shared attachments', () => {
  it("a hand-inserted link from a shared note to another user's attachment is unavailable", async () => {
    // the API never creates such a row (foreign ids in content are ignored); the join on the owner is
    // the last line of defence if one ever exists
    const bobsAid = await uploadPng(t.app, bob)
    t.db.prepare('INSERT INTO note_attachments (note_id, attachment_id) VALUES (?, ?)').run(noteId, bobsAid)
    const token = await unlock()
    expectUnavailable(await getSharedImage(noteId, bobsAid, { token }))
    // the same request for alice's own linked image works
    expect((await getSharedImage(noteId, aid, { token })).statusCode).toBe(200)
  })

  it("a valid token or link for note A cannot fetch an attachment linked only to note B", async () => {
    const onlyB = await uploadPng(t.app, alice)
    await newNote('B', docWithImages(onlyB))
    const token = await unlock()
    expectUnavailable(await getSharedImage(noteId, onlyB, { token }))
    const link = await shareSigned()
    expectUnavailable(await getSharedImage(noteId, onlyB, { query: linkQuery(link) }))
  })

  it("an image pasted from note A into shared note B is served through B's share, even after A is deleted", async () => {
    const noteB = await newNote('B', docWithImages(aid))
    const link = await shareSigned(noteB)
    const res = await getSharedImage(noteB, aid, { query: linkQuery(link) })
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.equals(PNG)).toBe(true)

    expect((await api(t.app, alice, 'DELETE', `/api/notes/${noteId}`)).statusCode).toBe(204)
    expect((await getSharedImage(noteB, aid, { query: linkQuery(link) })).statusCode).toBe(200)
  })

  it("an attachment no longer referenced by the shared note's content is unavailable", async () => {
    const token = await unlock()
    expect((await getSharedImage(noteId, aid, { token })).statusCode).toBe(200)
    await saveContent(noteId, doc('image removed'))
    expectUnavailable(await getSharedImage(noteId, aid, { token }))
    expect((await getShared(noteId, { token })).json().note.attachment_ids).toEqual([])
  })

  it('PIN mode accepts the token only from the Authorization header, never from ?token=', async () => {
    const token = await unlock()
    expectUnavailable(await getSharedImage(noteId, aid, { query: { token } }))
    expectUnavailable(await getShared(noteId, { query: { token } }))
    expect((await getSharedImage(noteId, aid, { token })).statusCode).toBe(200)
  })

  it('serves a linked image inline: no Content-Disposition and no sandbox CSP', async () => {
    const res = await getSharedImage(noteId, aid, { token: await unlock() })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBeUndefined()
    expect(res.headers['content-security-policy']).toBeUndefined()
  })

  it.each([
    ['a PDF', PDF, 'route.pdf', 'application/pdf'],
    ['a GPX', GPX, 'ridge.gpx', 'application/gpx+xml'],
  ])('serves %s as a sandboxed download with a PIN token or a signed link', async (_name, data, filename, mime) => {
    const fid = await uploadFile(t.app, alice, { data, filename })
    await saveContent(noteId, docWithFiles(fid))
    const token = await unlock()
    const viaToken = await getSharedImage(noteId, fid, { token })
    await stopSharing()
    const viaLink = await getSharedImage(noteId, fid, { query: linkQuery(await shareSigned()) })
    for (const res of [viaToken, viaLink]) {
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe(mime)
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${filename}"; filename*=UTF-8''${filename}`)
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-security-policy']).toBe('sandbox')
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.rawPayload.equals(data)).toBe(true)
    }
  })

  it('encodes a stored name with non-ASCII characters, quotes and semicolons safely', async () => {
    const fid = await uploadFile(t.app, alice, { data: PDF, filename: 'x.pdf' })
    t.db.prepare('UPDATE attachments SET original_name = ? WHERE id = ?').run('Ö"; x.pdf', fid)
    await saveContent(noteId, docWithFiles(fid))
    const res = await getSharedImage(noteId, fid, { token: await unlock() })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toBe(`attachment; filename="___ x.pdf"; filename*=UTF-8''%C3%96%22%3B%20x.pdf`)
  })

  it('a credential for note A cannot fetch a PDF or GPX linked only to note B (identical unavailable)', async () => {
    const pdf = await uploadFile(t.app, alice, { data: PDF })
    const gpx = await uploadFile(t.app, alice, { data: GPX })
    await newNote('B', docWithFiles(pdf, gpx))
    const token = await unlock()
    const missing = await getSharedImage(noteId, randomUUID(), { token })
    expectUnavailable(missing)
    for (const fid of [pdf, gpx]) {
      const res = await getSharedImage(noteId, fid, { token })
      expectUnavailable(res)
      expect(res.body).toBe(missing.body)
      expect(res.headers['content-disposition']).toBeUndefined()
    }
  })

  it("a shared note's credential cannot fetch another user's PDF hand-linked to it", async () => {
    const bobsPdf = await uploadFile(t.app, bob, { data: PDF })
    t.db.prepare('INSERT INTO note_attachments (note_id, attachment_id) VALUES (?, ?)').run(noteId, bobsPdf)
    expectUnavailable(await getSharedImage(noteId, bobsPdf, { token: await unlock() }))
  })

  it('a missing file on disk is unavailable, not an error', async () => {
    const storage = t.db.prepare('SELECT storage_name FROM attachments WHERE id = ?').pluck().get(aid) as string
    rmSync(path.join(uploadsDir(dataDir), storage))
    const token = await unlock()
    expectUnavailable(await getSharedImage(noteId, aid, { token }))
  })
})
