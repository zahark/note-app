import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
