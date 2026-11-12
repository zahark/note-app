// Attachment upload and owner fetch: magic-byte validation, size limit, random storage names and
// owner scoping.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectImageMime, extractAttachmentIds, MAX_ATTACHMENT_BYTES, uploadsDir } from '../src/services/attachments.js'
import { closeApp, errorCode, makeApp, type TestApp } from './helpers/auth.js'
import { api, loginAs, PNG, tmpDataDir, upload, uploadPng, type TestUser } from './helpers/api.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

let dataDir: string
let t: TestApp
let alice: TestUser
let bob: TestUser

beforeEach(async () => {
  dataDir = tmpDataDir()
  t = await makeApp({ env: { DATA_DIR: dataDir } })
  alice = await loginAs(t, 'alice@example.com')
  bob = await loginAs(t, 'bob@example.com')
})

afterEach(async () => {
  await closeApp(t)
  rmSync(dataDir, { recursive: true, force: true })
})

const uploadedFiles = () => (existsSync(uploadsDir(dataDir)) ? readdirSync(uploadsDir(dataDir)) : [])
const attachmentRows = () => t.db.prepare('SELECT COUNT(*) FROM attachments').pluck().get() as number

describe('detectImageMime', () => {
  it.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['GIF', GIF, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
  ])('recognises %s', (_name, bytes, mime) => {
    expect(detectImageMime(bytes)).toBe(mime)
  })

  it.each([
    ['SVG', SVG],
    ['plain text', Buffer.from('hello world')],
    ['empty', Buffer.alloc(0)],
    ['truncated PNG signature', PNG.subarray(0, 4)],
    ['RIFF that is not WebP', Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1')],
  ])('rejects %s', (_name, bytes) => {
    expect(detectImageMime(bytes)).toBeNull()
  })
})

describe('extractAttachmentIds', () => {
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'

  it('finds every attachment:// src, deduplicated, anywhere in the document', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: `attachment://${a}` } },
        { type: 'blockquote', content: [{ type: 'image', attrs: { src: `attachment://${b.toUpperCase()}` } }] },
        { type: 'image', attrs: { src: `attachment://${a}` } },
      ],
    }
    expect(extractAttachmentIds(content).sort()).toEqual([a, b])
  })

  it('ignores other URLs, malformed ids and strings merely containing a reference', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'https://example.com/cat.png' } },
        { type: 'image', attrs: { src: `/api/attachments/${a}` } },
        { type: 'image', attrs: { src: 'attachment://not-a-uuid' } },
        { type: 'paragraph', content: [{ type: 'text', text: `see attachment://${a} here` }] },
      ],
    }
    expect(extractAttachmentIds(content)).toEqual([])
  })
})

describe('POST /api/attachments', () => {
  it('stores a valid image and returns {id} (a UUID); the file name on disk is random', async () => {
    const res = await upload(t.app, alice, { filename: '../../etc/passwd.png' })
    expect(res.statusCode).toBe(201)
    const { id } = res.json() as { id: string }
    expect(Object.keys(res.json())).toEqual(['id'])
    expect(id).toMatch(UUID_V4)

    const row = t.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Record<string, unknown>
    expect(row).toMatchObject({
      user_id: alice.id,
      original_name: 'passwd.png',
      mime: 'image/png',
      size: PNG.length,
      last_unlinked_at: null,
    })
    expect(row.storage_name).toMatch(/^[0-9a-f]{32}$/)
    expect(uploadedFiles()).toEqual([row.storage_name])
    expect(readFileSync(path.join(uploadsDir(dataDir), row.storage_name as string))).toEqual(PNG)
  })

  it.each([
    ['JPEG', JPEG, 'image/jpeg'],
    ['GIF', GIF, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
  ])('accepts %s', async (_name, data, contentType) => {
    const res = await upload(t.app, alice, { data, contentType })
    expect(res.statusCode).toBe(201)
  })

  it('rejects a file over 10 MB with 413 and stores nothing', async () => {
    const data = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)])
    const res = await upload(t.app, alice, { data })
    expect(res.statusCode).toBe(413)
    expect(errorCode(res)).toBe('PAYLOAD_TOO_LARGE')
    expect(attachmentRows()).toBe(0)
    expect(uploadedFiles()).toEqual([])
  })

  it('accepts a file of exactly 10 MB', async () => {
    const data = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES - PNG.length)])
    const res = await upload(t.app, alice, { data })
    expect(res.statusCode).toBe(201)
  })

  it.each([
    ['SVG declared as SVG', { data: SVG, contentType: 'image/svg+xml', filename: 'x.svg' }],
    ['SVG declared as PNG', { data: SVG, contentType: 'image/png' }],
    ['text with a PNG mime (wrong magic bytes)', { data: Buffer.from('not an image'), contentType: 'image/png' }],
    ['PNG bytes declared as JPEG (wrong mime)', { data: PNG, contentType: 'image/jpeg' }],
    ['PNG bytes declared as octet-stream', { data: PNG, contentType: 'application/octet-stream' }],
  ])('rejects %s with 415 and stores nothing', async (_name, file) => {
    const res = await upload(t.app, alice, file)
    expect(res.statusCode).toBe(415)
    expect(errorCode(res)).toBe('UNSUPPORTED_MEDIA_TYPE')
    expect(attachmentRows()).toBe(0)
    expect(uploadedFiles()).toEqual([])
  })

  it('rejects a non-multipart body with 415', async () => {
    const res = await api(t.app, alice, 'POST', '/api/attachments', { file: 'x' })
    expect(res.statusCode).toBe(415)
    expect(errorCode(res)).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('requires a session and the exact Origin', async () => {
    expect((await upload(t.app, null)).statusCode).toBe(401)
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { origin: 'https://evil.example', 'content-type': 'multipart/form-data; boundary=x' },
      cookies: { sid: alice.sid },
      payload: '--x--\r\n',
    })
    expect(res.statusCode).toBe(403)
    expect(attachmentRows()).toBe(0)
  })
})

describe('GET /api/attachments/:aid', () => {
  it('serves the owner the bytes with the stored mime and nosniff', async () => {
    const aid = await uploadPng(t.app, alice)
    const res = await api(t.app, alice, 'GET', `/api/attachments/${aid}`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.rawPayload).toEqual(PNG)
  })

  it("user B fetching user A's attachment → 404, same as a missing id", async () => {
    const aid = await uploadPng(t.app, alice)
    const foreign = await api(t.app, bob, 'GET', `/api/attachments/${aid}`)
    const missing = await api(t.app, bob, 'GET', '/api/attachments/00000000-0000-4000-8000-000000000000')
    expect(foreign.statusCode).toBe(404)
    expect(errorCode(foreign)).toBe('NOT_FOUND')
    expect(foreign.body).toBe(missing.body)
  })

  it('requires a session', async () => {
    const aid = await uploadPng(t.app, alice)
    expect((await api(t.app, null, 'GET', `/api/attachments/${aid}`)).statusCode).toBe(401)
  })

  it('answers 404 when the file is gone from disk', async () => {
    const aid = await uploadPng(t.app, alice)
    rmSync(uploadsDir(dataDir), { recursive: true })
    expect((await api(t.app, alice, 'GET', `/api/attachments/${aid}`)).statusCode).toBe(404)
  })
})
