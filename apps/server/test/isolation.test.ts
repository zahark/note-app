// Cross-user isolation: every private endpoint, called by user B with user A's ids (in path params
// and in body fields), answers 404 and changes nothing of A's. Each task that adds a private endpoint
// appends a row to `ENDPOINTS`; the coverage test below fails until it does.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeApp, errorCode, makeApp, type TestApp } from './helpers/auth.js'
import {
  api,
  doc,
  docWithImages,
  loginAs,
  tmpDataDir,
  upload,
  uploadPng,
  type Method,
  type TestUser,
} from './helpers/api.js'

/** Resources created before every row runs: A's are the targets, B's let a row combine B's own path id with A's body id. */
interface Ids {
  aliceFolder: string
  aliceNote: string
  /** Linked to `aliceNote` through its content. */
  aliceAttachment: string
  bobFolder: string
  bobNote: string
}

interface Endpoint {
  method: Method
  /** The route pattern as registered (used by the coverage check). */
  route: string
  /** What the row calls; the name describes where A's id goes. */
  name: string
  url: (ids: Ids) => string
  body?: (ids: Ids) => unknown
}

const ENDPOINTS: Endpoint[] = [
  // folders (Task 7)
  {
    method: 'POST',
    route: '/api/folders',
    name: "body parent_folder_id = A's folder",
    url: () => '/api/folders',
    body: (i) => ({ name: 'x', parent_folder_id: i.aliceFolder }),
  },
  {
    method: 'PATCH',
    route: '/api/folders/:id',
    name: "path = A's folder",
    url: (i) => `/api/folders/${i.aliceFolder}`,
    body: () => ({ name: 'pwned' }),
  },
  {
    method: 'DELETE',
    route: '/api/folders/:id',
    name: "path = A's folder",
    url: (i) => `/api/folders/${i.aliceFolder}`,
  },
  // folder moves (Task 8)
  {
    method: 'PATCH',
    route: '/api/folders/:id/move',
    name: "path = A's folder, target = root",
    url: (i) => `/api/folders/${i.aliceFolder}/move`,
    body: () => ({ parent_folder_id: null }),
  },
  {
    method: 'PATCH',
    route: '/api/folders/:id/move',
    name: "path = A's folder, target = B's folder",
    url: (i) => `/api/folders/${i.aliceFolder}/move`,
    body: (i) => ({ parent_folder_id: i.bobFolder }),
  },
  {
    method: 'PATCH',
    route: '/api/folders/:id/move',
    name: "path = A's folder, target = A's own folder (would be a cycle)",
    url: (i) => `/api/folders/${i.aliceFolder}/move`,
    body: (i) => ({ parent_folder_id: i.aliceFolder }),
  },
  {
    method: 'PATCH',
    route: '/api/folders/:id/move',
    name: "path = B's folder, body parent_folder_id = A's folder",
    url: (i) => `/api/folders/${i.bobFolder}/move`,
    body: (i) => ({ parent_folder_id: i.aliceFolder }),
  },
  // notes (Task 7)
  {
    method: 'POST',
    route: '/api/notes',
    name: "body folder_id = A's folder",
    url: () => '/api/notes',
    body: (i) => ({ title: 'x', folder_id: i.aliceFolder }),
  },
  {
    method: 'GET',
    route: '/api/notes/:id',
    name: "path = A's note",
    url: (i) => `/api/notes/${i.aliceNote}`,
  },
  {
    method: 'PATCH',
    route: '/api/notes/:id',
    name: "path = A's note",
    url: (i) => `/api/notes/${i.aliceNote}`,
    body: () => ({ title: 'pwned' }),
  },
  {
    method: 'PUT',
    route: '/api/notes/:id/content',
    name: "path = A's note (at its current version)",
    url: (i) => `/api/notes/${i.aliceNote}/content`,
    body: () => ({ content: doc('pwned'), version: 2 }),
  },
  {
    method: 'DELETE',
    route: '/api/notes/:id',
    name: "path = A's note",
    url: (i) => `/api/notes/${i.aliceNote}`,
  },
  // note moves (Task 8)
  {
    method: 'PATCH',
    route: '/api/notes/:id/move',
    name: "path = A's note, target = root",
    url: (i) => `/api/notes/${i.aliceNote}/move`,
    body: () => ({ folder_id: null }),
  },
  {
    method: 'PATCH',
    route: '/api/notes/:id/move',
    name: "path = A's note, target = B's folder",
    url: (i) => `/api/notes/${i.aliceNote}/move`,
    body: (i) => ({ folder_id: i.bobFolder }),
  },
  {
    method: 'PATCH',
    route: '/api/notes/:id/move',
    name: "path = B's note, body folder_id = A's folder",
    url: (i) => `/api/notes/${i.bobNote}/move`,
    body: (i) => ({ folder_id: i.aliceFolder }),
  },
  // attachments (Task 9); the upload takes no id and is in ID_FREE_ROUTES
  {
    method: 'GET',
    route: '/api/attachments/:aid',
    name: "path = A's attachment",
    url: (i) => `/api/attachments/${i.aliceAttachment}`,
  },
  // sharing (Task 10); A's note is already link-shared, so a wrongly accepted call would change it
  {
    method: 'POST',
    route: '/api/notes/:id/share',
    name: "path = A's note, PIN share",
    url: (i) => `/api/notes/${i.aliceNote}/share`,
    body: () => ({ type: 'password_protected' }),
  },
  {
    method: 'POST',
    route: '/api/notes/:id/share',
    name: "path = A's note, signed link",
    url: (i) => `/api/notes/${i.aliceNote}/share`,
    body: () => ({ type: 'signed_url', expires_in: '30d' }),
  },
  {
    method: 'DELETE',
    route: '/api/notes/:id/share',
    name: "path = A's note",
    url: (i) => `/api/notes/${i.aliceNote}/share`,
  },
]

/** Private routes that take no id at all; each has its own scoping test below. */
const ID_FREE_ROUTES = ['GET /api/tree', 'POST /api/attachments']

/** Public surfaces, outside the owner-scoped API. */
const isPublic = (url: string) =>
  url === '/api/health' || url.startsWith('/api/auth/') || url.startsWith('/api/shared/')

let t: TestApp
let alice: TestUser
let bob: TestUser
let ids: Ids
let dataDir: string
const registered: string[] = []

beforeAll(async () => {
  dataDir = tmpDataDir()
  t = await makeApp({
    env: { DATA_DIR: dataDir },
    onRoute: (r) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method]
      for (const m of methods) if (m !== 'HEAD') registered.push(`${m} ${r.url}`)
    },
  })
  alice = await loginAs(t, 'alice@example.com')
  bob = await loginAs(t, 'bob@example.com')
})

afterAll(async () => {
  await closeApp(t)
  rmSync(dataDir, { recursive: true, force: true })
})

async function create(user: TestUser, url: string, body: object, key: 'folder' | 'note'): Promise<string> {
  const res = await api(t.app, user, 'POST', url, body)
  expect(res.statusCode).toBe(201)
  return res.json()[key].id
}

/** Fresh resources for each row, so a row that wrongly succeeded cannot hide behind an earlier one. */
async function seed(): Promise<Ids> {
  const aliceFolder = await create(alice, '/api/folders', { name: 'A folder' }, 'folder')
  const aliceNote = await create(alice, '/api/notes', { folder_id: aliceFolder, title: 'A note' }, 'note')
  const aliceAttachment = await uploadPng(t.app, alice)
  const saved = await api(t.app, alice, 'PUT', `/api/notes/${aliceNote}/content`, {
    content: docWithImages(aliceAttachment),
    version: 1,
  })
  expect(saved.statusCode).toBe(200)
  const shared = await api(t.app, alice, 'POST', `/api/notes/${aliceNote}/share`, {
    type: 'signed_url',
    expires_in: '1d',
  })
  expect(shared.statusCode).toBe(200)
  return {
    aliceFolder,
    aliceNote,
    aliceAttachment,
    bobFolder: await create(bob, '/api/folders', { name: 'B folder' }, 'folder'),
    bobNote: await create(bob, '/api/notes', { title: 'B note' }, 'note'),
  }
}

/** Everything of A's that an endpoint could touch. */
function aliceState() {
  return {
    folders: t.db.prepare('SELECT * FROM folders WHERE user_id = ? ORDER BY id').all(alice.id),
    notes: t.db.prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY id').all(alice.id),
    attachments: t.db.prepare('SELECT * FROM attachments WHERE user_id = ? ORDER BY id').all(alice.id),
    links: t.db
      .prepare(
        `SELECT na.* FROM note_attachments na JOIN notes n ON n.id = na.note_id
          WHERE n.user_id = ? ORDER BY na.note_id, na.attachment_id`,
      )
      .all(alice.id),
  }
}

/** Rows owned by B, to check that a rejected body-id request inserted nothing for B either. */
function bobRowCount(): number {
  return t.db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM folders WHERE user_id = @id) + (SELECT COUNT(*) FROM notes WHERE user_id = @id)
            + (SELECT COUNT(*) FROM attachments WHERE user_id = @id)`,
    )
    .pluck()
    .get({ id: bob.id }) as number
}

describe('cross-user isolation', () => {
  it('covers every private endpoint', async () => {
    const covered = new Set([...ENDPOINTS.map((e) => `${e.method} ${e.route}`), ...ID_FREE_ROUTES])
    const privateRoutes = registered.filter((r) => !isPublic(r.split(' ')[1]!))
    expect(privateRoutes.length).toBeGreaterThan(0)
    expect(privateRoutes.filter((r) => !covered.has(r))).toEqual([])
    // and the table has no stale rows for routes that no longer exist
    expect([...covered].filter((r) => !registered.includes(r))).toEqual([])
  })

  it.each(ENDPOINTS)("$method $route as user B ($name) → 404, A's data unchanged", async (e) => {
    ids = await seed()
    const before = aliceState()
    const bobRows = bobRowCount()

    const res = await api(t.app, bob, e.method, e.url(ids), e.body?.(ids))

    expect(res.statusCode).toBe(404)
    expect(errorCode(res)).toBe('NOT_FOUND')
    expect(aliceState()).toEqual(before)
    expect(bobRowCount()).toBe(bobRows)
  })

  it.each(ENDPOINTS)('$method $route without a session → 401', async (e) => {
    ids = await seed()
    const before = aliceState()
    const res = await api(t.app, null, e.method, e.url(ids), e.body?.(ids))
    expect(res.statusCode).toBe(401)
    expect(aliceState()).toEqual(before)
  })

  it("GET /api/tree as user B never lists A's folders or notes", async () => {
    ids = await seed()
    const res = await api(t.app, bob, 'GET', '/api/tree')
    expect(res.statusCode).toBe(200)
    const { folders, notes } = res.json() as { folders: { user_id: string }[]; notes: { user_id: string }[] }
    expect(folders.length).toBeGreaterThan(0)
    expect(notes.length).toBeGreaterThan(0)
    expect([...folders, ...notes].every((r) => r.user_id === bob.id)).toBe(true)
    expect((await api(t.app, null, 'GET', '/api/tree')).statusCode).toBe(401)
  })

  it("POST /api/attachments as user B creates B's attachment only; without a session → 401", async () => {
    ids = await seed()
    const before = aliceState()
    const res = await upload(t.app, bob)
    expect(res.statusCode).toBe(201)
    const owner = t.db.prepare('SELECT user_id FROM attachments WHERE id = ?').pluck().get(res.json().id)
    expect(owner).toBe(bob.id)
    expect(aliceState()).toEqual(before)

    const bobRows = bobRowCount()
    expect((await upload(t.app, null)).statusCode).toBe(401)
    expect(bobRowCount()).toBe(bobRows)
    expect(aliceState()).toEqual(before)
  })
})
