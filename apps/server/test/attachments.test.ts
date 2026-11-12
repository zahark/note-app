// Attachment upload and owner fetch: content-based type detection (images, PDF, GPX), per-kind size
// limits, random storage names and owner scoping.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectAttachmentKind,
  detectImageMime,
  extractAttachmentIds,
  GPX_SNIFF_BYTES,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  UPLOAD_LIMIT,
  uploadsDir,
} from '../src/services/attachments.js'
import { closeApp, errorCode, makeApp, ORIGIN, type TestApp } from './helpers/auth.js'
import { api, loginAs, PNG, tmpDataDir, upload, uploadPng, type TestUser } from './helpers/api.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00])
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1')
const GPX_BODY = '<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Ridge</name></trk></gpx>'
const GPX = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${GPX_BODY}\n`)
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const KML = Buffer.from('<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"></kml>')
const HTML = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>')
const DOCTYPE_GPX = Buffer.from(`<?xml version="1.0"?>\n<!DOCTYPE gpx [<!ENTITY x "boom">]>\n${GPX_BODY}`)
const ENTITY_GPX = Buffer.from(`${GPX_BODY}<!-- <!ENTITY x "boom"> -->`)

/** `head` padded to exactly `bytes` with `fill`, for size-limit tests that still pass type detection. */
const padTo = (head: Buffer, bytes: number, fill = 0) => Buffer.concat([head, Buffer.alloc(bytes - head.length, fill)])
/** A GPX of exactly `bytes`: trailing whitespace keeps it valid text after the root element. */
const gpxOf = (bytes: number) => padTo(GPX, bytes, 0x20)

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

describe('detectAttachmentKind', () => {
  it.each([
    ['PNG', PNG, { kind: 'image', mime: 'image/png' }],
    ['WebP', WEBP, { kind: 'image', mime: 'image/webp' }],
    ['PDF', PDF, { kind: 'pdf', mime: 'application/pdf' }],
    ['GPX with an XML declaration', GPX, { kind: 'gpx', mime: 'application/gpx+xml' }],
    ['GPX without an XML declaration', Buffer.from(GPX_BODY), { kind: 'gpx', mime: 'application/gpx+xml' }],
    ['GPX with a UTF-8 BOM', Buffer.concat([BOM, GPX]), { kind: 'gpx', mime: 'application/gpx+xml' }],
    [
      'GPX with leading comments and whitespace',
      Buffer.from(`<?xml version="1.0"?>\n<!-- exported -->\n  <!-- by <gpx>-ish app -->\r\n\t${GPX_BODY}`),
      { kind: 'gpx', mime: 'application/gpx+xml' },
    ],
    ['self-closing empty GPX', Buffer.from('<gpx/>'), { kind: 'gpx', mime: 'application/gpx+xml' }],
    ['GPX with non-ASCII text', Buffer.from(`<gpx><name>Перевал Ö</name></gpx>`), { kind: 'gpx', mime: 'application/gpx+xml' }],
  ])('recognises %s', (_name, bytes, expected) => {
    expect(detectAttachmentKind(bytes)).toEqual(expected)
  })

  it.each([
    ['SVG', SVG],
    ['KML', KML],
    ['HTML', HTML],
    ['GPX with a DOCTYPE', DOCTYPE_GPX],
    ['GPX with an ENTITY declaration (even inside a comment)', ENTITY_GPX],
    ['lower-case doctype', Buffer.from(`<!doctype gpx>${GPX_BODY}`)],
    ['namespace-prefixed root', Buffer.from('<g:gpx xmlns:g="http://www.topografix.com/GPX/1/1"></g:gpx>')],
    ['root whose name only starts with gpx', Buffer.from('<gpxdata></gpxdata>')],
    ['gpx element that is not the root', Buffer.from('<kml><gpx></gpx></kml>')],
    ['text before the root', Buffer.from(`hello ${GPX_BODY}`)],
    ['a processing instruction other than the XML declaration', Buffer.from(`<?xml-stylesheet href="x"?>${GPX_BODY}`)],
    ['an unterminated XML declaration', Buffer.from('<?xml version="1.0"')],
    ['an unterminated comment', Buffer.from(`<!-- ${GPX_BODY}`)],
    ['invalid UTF-8', Buffer.concat([Buffer.from('<gpx><name>'), Buffer.from([0xc3, 0x28]), Buffer.from('</name></gpx>')])],
    ['UTF-16 GPX', Buffer.from(`\ufeff${GPX_BODY}`, 'utf16le')],
    ['PDF signature not at the start', Buffer.concat([Buffer.from(' '), PDF])],
    ['random bytes', Buffer.from([0x00, 0x13, 0x37, 0xde, 0xad, 0xbe, 0xef, 0x42])],
    ['empty', Buffer.alloc(0)],
  ])('rejects %s', (_name, bytes) => {
    expect(detectAttachmentKind(bytes)).toBeNull()
  })

  it('tolerates a multi-byte character cut at the sniff boundary', () => {
    const head = Buffer.from(`${GPX_BODY}<!--`)
    const filler = Buffer.alloc(GPX_SNIFF_BYTES - head.length - 1, 0x61)
    // "Ж" is two bytes; its first byte is the last sniffed byte
    const data = Buffer.concat([head, filler, Buffer.from('Ж-->')])
    expect(detectAttachmentKind(data)).toEqual({ kind: 'gpx', mime: 'application/gpx+xml' })
  })

  it('does not find a root element that starts past the sniffed prefix', () => {
    const data = Buffer.concat([Buffer.from(`<!--${' '.repeat(GPX_SNIFF_BYTES)}-->`), Buffer.from(GPX_BODY)])
    expect(detectAttachmentKind(data)).toBeNull()
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

  it.each([
    ['PNG bytes named .jpg and declared as JPEG', { data: PNG, contentType: 'image/jpeg', filename: 'x.jpg' }, 'image/png'],
    ['WebP bytes declared as octet-stream', { data: WEBP, contentType: 'application/octet-stream' }, 'image/webp'],
  ])('accepts %s on its magic bytes and stores the detected type', async (_name, file, detected) => {
    const res = await upload(t.app, alice, file)
    expect(res.statusCode).toBe(201)
    const { id } = res.json() as { id: string }
    expect(t.db.prepare('SELECT mime FROM attachments WHERE id = ?').pluck().get(id)).toBe(detected)
    expect((await api(t.app, alice, 'GET', `/api/attachments/${id}`)).headers['content-type']).toBe(detected)
  })

  it('rejects an image over 10 MB with 413 and stores nothing', async () => {
    const data = padTo(PNG, MAX_IMAGE_BYTES + 1)
    const res = await upload(t.app, alice, { data })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Images are limited to 10 MB' } })
    expect(attachmentRows()).toBe(0)
    expect(uploadedFiles()).toEqual([])
  })

  it('accepts an image of exactly 10 MB', async () => {
    const res = await upload(t.app, alice, { data: padTo(PNG, MAX_IMAGE_BYTES) })
    expect(res.statusCode).toBe(201)
  })

  it.each([
    ['PDF', () => padTo(PDF, MAX_FILE_BYTES), 'application/pdf'],
    ['GPX', () => gpxOf(MAX_FILE_BYTES), 'application/gpx+xml'],
  ])('accepts a %s of exactly 25 MB', async (_name, data, mime) => {
    const res = await upload(t.app, alice, { data: data(), contentType: 'application/octet-stream' })
    expect(res.statusCode).toBe(201)
    const { id } = res.json() as { id: string }
    expect(t.db.prepare('SELECT mime, size FROM attachments WHERE id = ?').get(id)).toEqual({
      mime,
      size: MAX_FILE_BYTES,
    })
  })

  it.each([
    ['PDF', () => padTo(PDF, MAX_FILE_BYTES + 1)],
    ['GPX', () => gpxOf(MAX_FILE_BYTES + 1)],
  ])('rejects a %s over 25 MB with 413 and stores nothing', async (_name, data) => {
    const res = await upload(t.app, alice, { data: data(), contentType: 'application/octet-stream' })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Files are limited to 25 MB (images to 10 MB)' },
    })
    expect(attachmentRows()).toBe(0)
    expect(uploadedFiles()).toEqual([])
  })

  it('stores a PDF as application/pdf and serves it back', async () => {
    const res = await upload(t.app, alice, { data: PDF, contentType: 'application/pdf', filename: 'route.pdf' })
    expect(res.statusCode).toBe(201)
    const { id } = res.json() as { id: string }
    const row = t.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as Record<string, unknown>
    expect(row).toMatchObject({ user_id: alice.id, original_name: 'route.pdf', mime: 'application/pdf', size: PDF.length })
    expect(readFileSync(path.join(uploadsDir(dataDir), row.storage_name as string))).toEqual(PDF)
    const get = await api(t.app, alice, 'GET', `/api/attachments/${id}`)
    expect(get.headers['content-type']).toBe('application/pdf')
    expect(get.rawPayload).toEqual(PDF)
  })

  it.each([
    ['with an XML declaration', GPX],
    ['without an XML declaration', Buffer.from(GPX_BODY)],
    ['with a BOM', Buffer.concat([BOM, GPX])],
    ['with leading comments', Buffer.from(`<!-- Garmin -->\n<!-- export -->\n${GPX_BODY}`)],
  ])('stores a GPX %s as application/gpx+xml', async (_name, data) => {
    const res = await upload(t.app, alice, { data, contentType: '', filename: 'ridge.gpx' })
    expect(res.statusCode).toBe(201)
    const { id } = res.json() as { id: string }
    expect(t.db.prepare('SELECT mime, original_name FROM attachments WHERE id = ?').get(id)).toEqual({
      mime: 'application/gpx+xml',
      original_name: 'ridge.gpx',
    })
  })

  it.each([
    ['PDF bytes named .gpx and declared as PNG', { data: PDF, contentType: 'image/png', filename: 'x.gpx' }, 'application/pdf'],
    ['GPX bytes named .pdf and declared as PDF', { data: GPX, contentType: 'application/pdf', filename: 'x.pdf' }, 'application/gpx+xml'],
    ['GPX bytes named .png and declared as PNG', { data: GPX, contentType: 'image/png', filename: 'x.png' }, 'application/gpx+xml'],
  ])('ignores a disagreeing declared type and extension: %s', async (_name, file, detected) => {
    const res = await upload(t.app, alice, file)
    expect(res.statusCode).toBe(201)
    const { id } = res.json() as { id: string }
    expect(t.db.prepare('SELECT mime FROM attachments WHERE id = ?').pluck().get(id)).toBe(detected)
  })

  it.each([
    ['an image', PNG, 'image'],
    ['a PDF', PDF, 'document.pdf'],
    ['a GPX', GPX, 'track.gpx'],
  ])('falls back to a per-kind name for %s uploaded without a usable file name', async (_name, data, name) => {
    const res = await upload(t.app, alice, { data, filename: 'folder/' })
    expect(res.statusCode).toBe(201)
    const { id } = res.json() as { id: string }
    expect(t.db.prepare('SELECT original_name FROM attachments WHERE id = ?').pluck().get(id)).toBe(name)
  })

  it.each([
    ['SVG declared as SVG', { data: SVG, contentType: 'image/svg+xml', filename: 'x.svg' }],
    ['SVG declared as PNG', { data: SVG, contentType: 'image/png' }],
    ['text with a PNG mime (wrong magic bytes)', { data: Buffer.from('not an image'), contentType: 'image/png' }],
    ['KML named .gpx', { data: KML, contentType: 'application/gpx+xml', filename: 'x.gpx' }],
    ['SVG named .gpx', { data: SVG, contentType: 'application/gpx+xml', filename: 'x.gpx' }],
    ['a GPX with a DOCTYPE', { data: DOCTYPE_GPX, contentType: 'application/gpx+xml', filename: 'x.gpx' }],
    ['a GPX with an ENTITY', { data: ENTITY_GPX, contentType: 'application/gpx+xml', filename: 'x.gpx' }],
    ['HTML named .pdf', { data: HTML, contentType: 'application/pdf', filename: 'x.pdf' }],
    ['random bytes named .pdf', { data: Buffer.from([0x13, 0x37, 0, 1, 2, 3]), contentType: 'application/pdf', filename: 'x.pdf' }],
  ])('rejects %s with 415 and stores nothing', async (_name, file) => {
    const res = await upload(t.app, alice, file)
    expect(res.statusCode).toBe(415)
    expect(res.json()).toEqual({
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Only PNG, JPEG, WebP and GIF images, PDF files and GPX tracks are allowed',
      },
    })
    expect(attachmentRows()).toBe(0)
    expect(uploadedFiles()).toEqual([])
  })

  /** A raw multipart upload with the given parts (each `{name, filename?, data}`). */
  function multipart(parts: Array<{ name: string; filename?: string; data: Buffer | string }>) {
    const boundary = '----edge-case-boundary'
    const chunks: Buffer[] = []
    for (const p of parts) {
      const disposition = `form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}`
      const type = p.filename ? 'Content-Type: image/png\r\n' : ''
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n`))
      chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data))
      chunks.push(Buffer.from('\r\n'))
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`))
    return t.app.inject({
      method: 'POST',
      url: '/api/attachments',
      headers: { origin: ORIGIN, 'content-type': `multipart/form-data; boundary=${boundary}` },
      cookies: { sid: alice.sid },
      payload: Buffer.concat(chunks),
    })
  }

  it('a multipart body without any part → 400 "No file uploaded", nothing stored', async () => {
    const res = await multipart([])
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'No file uploaded' } })
    expect(attachmentRows()).toBe(0)
    expect(uploadedFiles()).toEqual([])
  })

  it('a text field part (the parts limit allows no fields) is refused with 413, nothing stored', async () => {
    const res = await multipart([{ name: 'note', data: 'hello' }])
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) } })
    expect(attachmentRows()).toBe(0)
    expect(uploadedFiles()).toEqual([])
  })

  it('with two file parts only the first is stored (one file per upload)', async () => {
    const res = await multipart([
      { name: 'file', filename: 'a.png', data: PNG },
      { name: 'file', filename: 'b.png', data: PNG },
    ])
    expect(res.statusCode).toBe(201)
    expect(attachmentRows()).toBe(1)
    expect(uploadedFiles()).toHaveLength(1)
    expect(t.db.prepare('SELECT original_name FROM attachments').pluck().get()).toBe('a.png')
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

describe('POST /api/attachments: per-account rate limit', () => {
  it(`allows ${UPLOAD_LIMIT.limit} uploads per 15 minutes per account, then 429 with Retry-After`, async () => {
    for (let i = 0; i < UPLOAD_LIMIT.limit; i++) await uploadPng(t.app, alice)
    const res = await upload(t.app, alice)
    expect(res.statusCode).toBe(429)
    expect(errorCode(res)).toBe('RATE_LIMITED')
    expect(res.json().error.message).toMatch(/Too many uploads/)
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    expect(attachmentRows()).toBe(UPLOAD_LIMIT.limit)

    // another account is not affected
    expect((await upload(t.app, bob)).statusCode).toBe(201)
    // and the window slides
    t.clock.advance(UPLOAD_LIMIT.windowMs)
    expect((await upload(t.app, alice)).statusCode).toBe(201)
  })

  it('counts PDF and GPX uploads against the same limit as images, and limits them the same way', async () => {
    for (let i = 0; i < UPLOAD_LIMIT.limit; i++) {
      const data = [PNG, PDF, GPX][i % 3]
      expect((await upload(t.app, alice, { data })).statusCode).toBe(201)
    }
    for (const data of [PDF, GPX]) {
      const res = await upload(t.app, alice, { data })
      expect(res.statusCode).toBe(429)
      expect(errorCode(res)).toBe('RATE_LIMITED')
    }
    expect(attachmentRows()).toBe(UPLOAD_LIMIT.limit)
  })
})

describe('POST /api/attachments: per-account storage quota', () => {
  const KIB = 1024
  /** PNG magic bytes padded to `kib` KiB: enough for the type check. */
  const pngOf = (kib: number) => Buffer.concat([PNG, Buffer.alloc(kib * KIB - PNG.length)])

  let q: TestApp
  let carol: TestUser
  let dave: TestUser
  let quotaDir: string

  beforeEach(async () => {
    quotaDir = tmpDataDir()
    q = await makeApp({ env: { DATA_DIR: quotaDir, UPLOAD_QUOTA_MB: '1' } })
    carol = await loginAs(q, 'carol@example.com')
    dave = await loginAs(q, 'dave@example.com')
  })

  afterEach(async () => {
    await closeApp(q)
    rmSync(quotaDir, { recursive: true, force: true })
  })

  const files = () => (existsSync(uploadsDir(quotaDir)) ? readdirSync(uploadsDir(quotaDir)) : [])

  it('refuses an upload that would exceed UPLOAD_QUOTA_MB with 413 QUOTA_EXCEEDED and stores nothing', async () => {
    expect((await upload(q.app, carol, { data: pngOf(600) })).statusCode).toBe(201)
    const res = await upload(q.app, carol, { data: pngOf(600) })
    expect(res.statusCode).toBe(413)
    expect(errorCode(res)).toBe('QUOTA_EXCEEDED')
    expect(res.json().error.message).toMatch(/Attachment storage is full \(1 MB per account\)/)
    expect(files()).toHaveLength(1)

    // what still fits is accepted; the quota is per account
    expect((await upload(q.app, carol, { data: pngOf(400) })).statusCode).toBe(201)
    expect((await upload(q.app, dave, { data: pngOf(600) })).statusCode).toBe(201)
  })

  it('PDF and GPX files share the quota with images', async () => {
    expect((await upload(q.app, carol, { data: padTo(PDF, 400 * KIB) })).statusCode).toBe(201)
    expect((await upload(q.app, carol, { data: padTo(GPX, 400 * KIB, 0x20) })).statusCode).toBe(201)
    for (const data of [pngOf(300), padTo(PDF, 300 * KIB), padTo(GPX, 300 * KIB, 0x20)]) {
      const res = await upload(q.app, carol, { data })
      expect(res.statusCode).toBe(413)
      expect(errorCode(res)).toBe('QUOTA_EXCEEDED')
    }
    expect(files()).toHaveLength(2)
    expect((await upload(q.app, carol, { data: padTo(GPX, 200 * KIB, 0x20) })).statusCode).toBe(201)
  })

  it('a full account is refused before the body is stored', async () => {
    expect((await upload(q.app, carol, { data: pngOf(1024) })).statusCode).toBe(201)
    const res = await upload(q.app, carol)
    expect(res.statusCode).toBe(413)
    expect(errorCode(res)).toBe('QUOTA_EXCEEDED')
    expect(files()).toHaveLength(1)
  })

  it('parallel uploads cannot together overshoot the quota', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => upload(q.app, carol, { data: pngOf(600) })))
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 413, 413, 413])
    expect(files()).toHaveLength(1)
  })

  it('UPLOAD_QUOTA_MB=0 means no quota', async () => {
    const free = await makeApp({ env: { DATA_DIR: quotaDir, UPLOAD_QUOTA_MB: '0' } })
    try {
      const erin = await loginAs(free, 'erin@example.com')
      for (let i = 0; i < 3; i++) {
        expect((await upload(free.app, erin, { data: pngOf(600) })).statusCode).toBe(201)
      }
    } finally {
      await closeApp(free)
    }
  })
})

describe('GET /api/attachments/:aid', () => {
  it('serves the owner the bytes with the stored mime and nosniff', async () => {
    const aid = await uploadPng(t.app, alice)
    const res = await api(t.app, alice, 'GET', `/api/attachments/${aid}`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    // ids are never reused, so the bytes may be cached, but only by the owner's browser
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable')
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
