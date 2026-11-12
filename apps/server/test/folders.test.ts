import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeApp, errorCode, makeApp, type TestApp } from './helpers/auth.js'
import { api, loginAs, type TestUser } from './helpers/api.js'

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

async function createFolder(user: TestUser, body: object) {
  const res = await api(t.app, user, 'POST', '/api/folders', body)
  expect(res.statusCode).toBe(201)
  return res.json().folder as { id: string; name: string; parent_folder_id: string | null }
}

describe('POST /api/folders', () => {
  it('creates a root folder', async () => {
    const res = await api(t.app, alice, 'POST', '/api/folders', { name: 'Work' })
    expect(res.statusCode).toBe(201)
    const { folder } = res.json()
    expect(folder).toMatchObject({ name: 'Work', parent_folder_id: null, user_id: alice.id })
    expect(folder.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('creates a nested folder inside an own folder', async () => {
    const parent = await createFolder(alice, { name: 'Work' })
    const child = await createFolder(alice, { name: 'Projects', parent_folder_id: parent.id })
    expect(child.parent_folder_id).toBe(parent.id)
  })

  it('trims the name and rejects an empty or overlong one', async () => {
    expect((await createFolder(alice, { name: '  Work  ' })).name).toBe('Work')
    for (const name of ['', '   ', 'x'.repeat(256)]) {
      const res = await api(t.app, alice, 'POST', '/api/folders', { name })
      expect(res.statusCode).toBe(400)
      expect(errorCode(res)).toBe('VALIDATION_ERROR')
    }
    expect(count('SELECT COUNT(*) FROM folders')).toBe(1)
  })

  it("returns 404 and inserts nothing for another user's parent folder", async () => {
    const aliceFolder = await createFolder(alice, { name: 'Private' })
    const res = await api(t.app, bob, 'POST', '/api/folders', { name: 'Sneaky', parent_folder_id: aliceFolder.id })
    expect(res.statusCode).toBe(404)
    expect(errorCode(res)).toBe('NOT_FOUND')
    expect(count('SELECT COUNT(*) FROM folders WHERE user_id = ?', bob.id)).toBe(0)
  })

  it('returns 404 and inserts nothing for a nonexistent parent folder', async () => {
    const res = await api(t.app, alice, 'POST', '/api/folders', { name: 'X', parent_folder_id: randomUUID() })
    expect(res.statusCode).toBe(404)
    expect(count('SELECT COUNT(*) FROM folders')).toBe(0)
  })

  it('requires a session', async () => {
    const res = await api(t.app, null, 'POST', '/api/folders', { name: 'Work' })
    expect(res.statusCode).toBe(401)
    expect(count('SELECT COUNT(*) FROM folders')).toBe(0)
  })
})

describe('PATCH /api/folders/:id', () => {
  it('renames the folder', async () => {
    const folder = await createFolder(alice, { name: 'Work' })
    const res = await api(t.app, alice, 'PATCH', `/api/folders/${folder.id}`, { name: 'Job' })
    expect(res.statusCode).toBe(200)
    expect(res.json().folder).toMatchObject({ id: folder.id, name: 'Job' })
    expect(count("SELECT COUNT(*) FROM folders WHERE name = 'Job'")).toBe(1)
  })

  it('rejects unknown fields and an empty name', async () => {
    const folder = await createFolder(alice, { name: 'Work' })
    for (const body of [{ name: '' }, { name: 'Job', parent_folder_id: null }, {}]) {
      const res = await api(t.app, alice, 'PATCH', `/api/folders/${folder.id}`, body)
      expect(res.statusCode).toBe(400)
    }
    expect(count("SELECT COUNT(*) FROM folders WHERE name = 'Work'")).toBe(1)
  })

  it('returns 404 for a missing folder', async () => {
    const res = await api(t.app, alice, 'PATCH', `/api/folders/${randomUUID()}`, { name: 'Job' })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /api/folders/:id', () => {
  it('deletes the folder with its subtree of folders and notes', async () => {
    const top = await createFolder(alice, { name: 'Top' })
    const mid = await createFolder(alice, { name: 'Mid', parent_folder_id: top.id })
    await api(t.app, alice, 'POST', '/api/notes', { folder_id: mid.id, title: 'deep' })
    const keep = await createFolder(alice, { name: 'Keep' })

    const res = await api(t.app, alice, 'DELETE', `/api/folders/${top.id}`)
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    expect(t.db.prepare('SELECT id FROM folders').pluck().all()).toEqual([keep.id])
    expect(count('SELECT COUNT(*) FROM notes')).toBe(0)
  })

  it('returns 404 for a missing folder and a second delete', async () => {
    const folder = await createFolder(alice, { name: 'Work' })
    expect((await api(t.app, alice, 'DELETE', `/api/folders/${folder.id}`)).statusCode).toBe(204)
    expect((await api(t.app, alice, 'DELETE', `/api/folders/${folder.id}`)).statusCode).toBe(404)
  })
})

describe('GET /api/tree', () => {
  it('returns the flat folders and notes of the caller only, without content', async () => {
    const work = await createFolder(alice, { name: 'Work' })
    const sub = await createFolder(alice, { name: 'Sub', parent_folder_id: work.id })
    const inFolder = await api(t.app, alice, 'POST', '/api/notes', { folder_id: sub.id, title: 'In sub' })
    const atRoot = await api(t.app, alice, 'POST', '/api/notes', { title: 'At root' })
    await api(t.app, alice, 'PUT', `/api/notes/${atRoot.json().note.id}/content`, {
      content: { type: 'doc', content: [] },
      version: 1,
    })
    await createFolder(bob, { name: 'Bob folder' })
    await api(t.app, bob, 'POST', '/api/notes', { title: 'Bob note' })

    const res = await api(t.app, alice, 'GET', '/api/tree')
    expect(res.statusCode).toBe(200)
    const tree = res.json()
    expect(tree.folders.map((f: { name: string }) => f.name).sort()).toEqual(['Sub', 'Work'])
    expect(tree.folders.find((f: { id: string }) => f.id === sub.id).parent_folder_id).toBe(work.id)
    expect(tree.notes).toHaveLength(2)
    expect(tree.notes.find((n: { id: string }) => n.id === inFolder.json().note.id)).toMatchObject({
      title: 'In sub',
      folder_id: sub.id,
      version: 1,
    })
    expect(tree.notes.find((n: { title: string }) => n.title === 'At root')).toMatchObject({
      folder_id: null,
      version: 2,
    })
    for (const note of tree.notes) {
      expect(note).not.toHaveProperty('content')
      expect(note).not.toHaveProperty('share_secret')
    }
  })

  it('returns empty lists for a new user', async () => {
    const res = await api(t.app, alice, 'GET', '/api/tree')
    expect(res.json()).toEqual({ folders: [], notes: [] })
  })

  it('requires a session', async () => {
    expect((await api(t.app, null, 'GET', '/api/tree')).statusCode).toBe(401)
  })
})
