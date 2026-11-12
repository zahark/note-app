import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOTE_LIMITS } from '../src/routes/notes.js'
import { closeApp, errorCode, makeApp, type TestApp } from './helpers/auth.js'
import { api, doc, loginAs, type TestUser } from './helpers/api.js'

let t: TestApp
let alice: TestUser
let bob: TestUser

beforeEach(async () => {
  t = await makeApp()
  alice = await loginAs(t, 'alice@example.com')
  bob = await loginAs(t, 'bob@example.com')
})
afterEach(async () => {
  await closeApp(t)
})

const count = (sql: string, ...params: unknown[]) => t.db.prepare(sql).pluck().get(...params) as number

interface NoteJson {
  id: string
  title: string
  folder_id: string | null
  version: number
  content?: unknown
}

async function createNote(user: TestUser, body: object = {}): Promise<NoteJson> {
  const res = await api(t.app, user, 'POST', '/api/notes', body)
  expect(res.statusCode).toBe(201)
  return res.json().note
}

async function createFolder(user: TestUser, name = 'Folder'): Promise<string> {
  const res = await api(t.app, user, 'POST', '/api/folders', { name })
  expect(res.statusCode).toBe(201)
  return res.json().folder.id
}

const saveContent = (user: TestUser, id: string, body: object) =>
  api(t.app, user, 'PUT', `/api/notes/${id}/content`, body)

const getNote = async (user: TestUser, id: string): Promise<NoteJson> => {
  const res = await api(t.app, user, 'GET', `/api/notes/${id}`)
  expect(res.statusCode).toBe(200)
  return res.json().note
}

describe('POST /api/notes', () => {
  it('creates an empty untitled note at the root', async () => {
    const note = await createNote(alice)
    expect(note).toMatchObject({ title: '', folder_id: null, version: 1, content: { type: 'doc', content: [] } })
    expect(note).not.toHaveProperty('share_secret')
  })

  it('creates a titled note inside an own folder', async () => {
    const folderId = await createFolder(alice)
    const note = await createNote(alice, { folder_id: folderId, title: 'Plan' })
    expect(note).toMatchObject({ title: 'Plan', folder_id: folderId })
  })

  it("returns 404 and inserts nothing for another user's folder", async () => {
    const aliceFolder = await createFolder(alice)
    const res = await api(t.app, bob, 'POST', '/api/notes', { folder_id: aliceFolder, title: 'Sneaky' })
    expect(res.statusCode).toBe(404)
    expect(errorCode(res)).toBe('NOT_FOUND')
    expect(count('SELECT COUNT(*) FROM notes')).toBe(0)
  })

  it('returns 404 and inserts nothing for a nonexistent folder', async () => {
    const res = await api(t.app, alice, 'POST', '/api/notes', { folder_id: randomUUID() })
    expect(res.statusCode).toBe(404)
    expect(count('SELECT COUNT(*) FROM notes')).toBe(0)
  })

  it('rejects an overlong title and unknown fields', async () => {
    for (const body of [{ title: 'x'.repeat(501) }, { title: 'ok', version: 5 }]) {
      const res = await api(t.app, alice, 'POST', '/api/notes', body)
      expect(res.statusCode).toBe(400)
      expect(errorCode(res)).toBe('VALIDATION_ERROR')
    }
    expect(count('SELECT COUNT(*) FROM notes')).toBe(0)
  })

  it('requires a session', async () => {
    expect((await api(t.app, null, 'POST', '/api/notes', {})).statusCode).toBe(401)
  })
})

describe('GET /api/notes/:id', () => {
  it('returns the note with its content', async () => {
    const { id } = await createNote(alice, { title: 'Hello' })
    await saveContent(alice, id, { content: doc('hi'), version: 1 })
    expect(await getNote(alice, id)).toMatchObject({ id, title: 'Hello', version: 2, content: doc('hi') })
  })

  it('returns 404 for a missing note', async () => {
    expect((await api(t.app, alice, 'GET', `/api/notes/${randomUUID()}`)).statusCode).toBe(404)
  })

  it.each([101, 150])('a %i-char id gets the standard 404 error body (not the router’s 414)', async (n) => {
    for (const [method, url] of [
      ['GET', `/api/notes/${'x'.repeat(n)}`],
      ['PUT', `/api/notes/${'x'.repeat(n)}/content`],
      ['DELETE', `/api/folders/${'x'.repeat(n)}`],
    ] as const) {
      const res = await api(t.app, alice, method, url, method === 'PUT' ? { content: doc('x'), version: 1 } : undefined)
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } })
    }
  })
})

describe('PUT /api/notes/:id/content', () => {
  it('saves at the matching version and returns version + 1', async () => {
    const { id } = await createNote(alice)
    const first = await saveContent(alice, id, { content: doc('one'), version: 1 })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toEqual({ version: 2 })
    const second = await saveContent(alice, id, { content: doc('two'), version: 2 })
    expect(second.json()).toEqual({ version: 3 })
    expect((await getNote(alice, id)).content).toEqual(doc('two'))
  })

  it('rejects a stale version with 409 and keeps the stored content', async () => {
    const { id } = await createNote(alice)
    await saveContent(alice, id, { content: doc('one'), version: 1 })
    const stale = await saveContent(alice, id, { content: doc('stale'), version: 1 })
    expect(stale.statusCode).toBe(409)
    expect(errorCode(stale)).toBe('VERSION_CONFLICT')
    expect(await getNote(alice, id)).toMatchObject({ version: 2, content: doc('one') })
  })

  it('rejects a title field and changes nothing', async () => {
    const { id } = await createNote(alice, { title: 'Original' })
    const res = await saveContent(alice, id, { content: doc('x'), version: 1, title: 'Hijacked' })
    expect(res.statusCode).toBe(400)
    expect(errorCode(res)).toBe('VALIDATION_ERROR')
    expect(await getNote(alice, id)).toMatchObject({ title: 'Original', version: 1 })
  })

  it('rejects a missing version or a content that is not a doc', async () => {
    const { id } = await createNote(alice)
    for (const body of [
      { content: doc('x') },
      { content: doc('x'), version: 0 },
      { content: doc('x'), version: 1.5 },
      { content: 'text', version: 1 },
      { content: { type: 'paragraph' }, version: 1 },
      { version: 1 },
    ]) {
      expect((await saveContent(alice, id, body)).statusCode).toBe(400)
    }
    expect((await getNote(alice, id)).version).toBe(1)
  })

  it('returns 404 for a missing note', async () => {
    const res = await saveContent(alice, randomUUID(), { content: doc('x'), version: 1 })
    expect(res.statusCode).toBe(404)
  })

  /** A doc whose JSON body is a little over `bytes` long. */
  const docOfSize = (bytes: number) => doc('x'.repeat(bytes))

  it('accepts a body over the 1 MiB default limit (up to 5 MiB)', async () => {
    const { id } = await createNote(alice)
    const res = await saveContent(alice, id, { content: docOfSize(2 * 1024 * 1024), version: 1 })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ version: 2 })
  })

  it('rejects a body over 5 MiB with 413 PAYLOAD_TOO_LARGE in the standard error format', async () => {
    const { id } = await createNote(alice)
    const res = await saveContent(alice, id, { content: docOfSize(5 * 1024 * 1024), version: 1 })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) } })
    expect((await getNote(alice, id)).version).toBe(1)
  })

  it('other routes keep the 1 MiB default', async () => {
    const { id } = await createNote(alice)
    const res = await api(t.app, alice, 'PATCH', `/api/notes/${id}`, { title: 'x'.repeat(2 * 1024 * 1024) })
    expect(res.statusCode).toBe(413)
  })
})

describe('PATCH /api/notes/:id (rename)', () => {
  it('renames without changing version', async () => {
    const { id } = await createNote(alice, { title: 'Old' })
    await saveContent(alice, id, { content: doc('body'), version: 1 })
    const res = await api(t.app, alice, 'PATCH', `/api/notes/${id}`, { title: 'New' })
    expect(res.statusCode).toBe(200)
    expect(res.json().note).toMatchObject({ id, title: 'New', version: 2 })
    expect(res.json().note).not.toHaveProperty('content')
    expect(await getNote(alice, id)).toMatchObject({ title: 'New', version: 2, content: doc('body') })
  })

  it('rejects a version or content field (renames never take part in version checks)', async () => {
    const { id } = await createNote(alice, { title: 'Old' })
    for (const body of [{ title: 'New', version: 1 }, { title: 'New', content: doc('x') }, {}]) {
      const res = await api(t.app, alice, 'PATCH', `/api/notes/${id}`, body)
      expect(res.statusCode).toBe(400)
    }
    expect(await getNote(alice, id)).toMatchObject({ title: 'Old', version: 1 })
  })

  it('allows an empty title', async () => {
    const { id } = await createNote(alice, { title: 'Old' })
    const res = await api(t.app, alice, 'PATCH', `/api/notes/${id}`, { title: '' })
    expect(res.statusCode).toBe(200)
    expect((await getNote(alice, id)).title).toBe('')
  })

  it('a content save at the pre-rename version succeeds and keeps the new title', async () => {
    const { id } = await createNote(alice, { title: 'Old' })
    await api(t.app, alice, 'PATCH', `/api/notes/${id}`, { title: 'Renamed' })
    const save = await saveContent(alice, id, { content: doc('after rename'), version: 1 })
    expect(save.statusCode).toBe(200)
    expect(save.json()).toEqual({ version: 2 })
    expect(await getNote(alice, id)).toMatchObject({ title: 'Renamed', content: doc('after rename') })
  })

  it('a folder rename leaves its notes and their versions alone', async () => {
    const folderId = await createFolder(alice, 'Work')
    const { id } = await createNote(alice, { folder_id: folderId })
    await api(t.app, alice, 'PATCH', `/api/folders/${folderId}`, { name: 'Job' })
    expect(await getNote(alice, id)).toMatchObject({ version: 1, folder_id: folderId })
    expect((await saveContent(alice, id, { content: doc('x'), version: 1 })).statusCode).toBe(200)
  })

  it('returns 404 for a missing note', async () => {
    const res = await api(t.app, alice, 'PATCH', `/api/notes/${randomUUID()}`, { title: 'x' })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /api/notes/:id', () => {
  it('deletes the note', async () => {
    const { id } = await createNote(alice)
    const keep = await createNote(alice)
    const res = await api(t.app, alice, 'DELETE', `/api/notes/${id}`)
    expect(res.statusCode).toBe(204)
    expect(t.db.prepare('SELECT id FROM notes').pluck().all()).toEqual([keep.id])
    expect((await api(t.app, alice, 'DELETE', `/api/notes/${id}`)).statusCode).toBe(404)
  })
})

describe('per-account write limits', () => {
  it(`allows ${NOTE_LIMITS.creates.limit} note creations per 15 minutes per account, then 429 with Retry-After`, async () => {
    for (let i = 0; i < NOTE_LIMITS.creates.limit; i++) await createNote(alice)
    const res = await api(t.app, alice, 'POST', '/api/notes', {})
    expect(res.statusCode).toBe(429)
    expect(errorCode(res)).toBe('RATE_LIMITED')
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(count('SELECT COUNT(*) FROM notes WHERE user_id = ?', alice.id)).toBe(NOTE_LIMITS.creates.limit)

    // another account is not affected, and the window slides
    await createNote(bob)
    t.clock.advance(NOTE_LIMITS.creates.windowMs)
    await createNote(alice)
  })

  it(`allows ${NOTE_LIMITS.contentSaves.limit} content saves per 15 minutes per account, counted before the body is read`, async () => {
    const { id } = await createNote(alice)
    // every attempt counts, even one whose body is rejected
    for (let i = 0; i < NOTE_LIMITS.contentSaves.limit; i++) {
      expect((await saveContent(alice, id, {})).statusCode).toBe(400)
    }
    const valid = await saveContent(alice, id, { content: doc('x'), version: 1 })
    expect(valid.statusCode).toBe(429)
    expect(errorCode(valid)).toBe('RATE_LIMITED')
    expect(Number(valid.headers['retry-after'])).toBeGreaterThan(0)
    // a limited request is refused before its body is parsed or validated
    expect((await saveContent(alice, id, {})).statusCode).toBe(429)
    expect(await getNote(alice, id)).toMatchObject({ version: 1 })

    // refused attempts do not extend the window; other accounts are not affected
    const bobNote = await createNote(bob)
    expect((await saveContent(bob, bobNote.id, { content: doc('y'), version: 1 })).statusCode).toBe(200)
    t.clock.advance(NOTE_LIMITS.contentSaves.windowMs)
    expect((await saveContent(alice, id, { content: doc('x'), version: 1 })).statusCode).toBe(200)
  })
})
