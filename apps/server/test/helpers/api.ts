// Fixtures for the private API tests: logged-in users and an authenticated request helper.
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { cookieValue, login, ORIGIN, seedUser, type TestApp } from './auth.js'

export interface TestUser {
  id: string
  sid: string
}

/** Seeds a user and logs them in, returning their id and session token. */
export async function loginAs(t: TestApp, email: string): Promise<TestUser> {
  const id = seedUser(t.db, email)
  const res = await login(t.app, { email })
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`)
  return { id, sid: cookieValue(res, 'sid') }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** An authenticated request (session cookie plus the exact Origin every mutating request needs). */
export function api(
  app: FastifyInstance,
  user: TestUser | null,
  method: Method,
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { origin: ORIGIN },
    cookies: user ? { sid: user.sid } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
}

export const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

/** A real 1×1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

/** A minimal PDF (detected by its leading `%PDF-`). */
export const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1')

/** The root element of a minimal GPX track. */
export const GPX_BODY =
  '<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Ridge</name></trk></gpx>'

/** A minimal GPX file with an XML declaration. */
export const GPX = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${GPX_BODY}\n`)

/** A temporary DATA_DIR for tests that write uploads; remove it with `fs.rmSync(dir, {recursive:true})`. */
export function tmpDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'notes-app-test-'))
}

export interface UploadFile {
  filename?: string
  contentType?: string
  data?: Buffer
}

/** `POST /api/attachments` with one multipart file part (a PNG by default). */
export function upload(
  app: FastifyInstance,
  user: TestUser | null,
  file: UploadFile = {},
): Promise<LightMyRequestResponse> {
  const boundary = '----notes-app-test-boundary'
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${file.filename ?? 'cat.png'}"\r\n` +
        `Content-Type: ${file.contentType ?? 'image/png'}\r\n\r\n`,
    ),
    file.data ?? PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return app.inject({
    method: 'POST',
    url: '/api/attachments',
    headers: { origin: ORIGIN, 'content-type': `multipart/form-data; boundary=${boundary}` },
    cookies: user ? { sid: user.sid } : {},
    payload,
  })
}

/** Uploads a PNG as `user` and returns the new attachment id. */
export async function uploadPng(app: FastifyInstance, user: TestUser): Promise<string> {
  const res = await upload(app, user)
  if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`)
  return (res.json() as { id: string }).id
}

/** Uploads `file` as `user` and returns the new attachment id. */
export async function uploadFile(app: FastifyInstance, user: TestUser, file: UploadFile): Promise<string> {
  const res = await upload(app, user, file)
  if (res.statusCode !== 201) throw new Error(`upload failed: ${res.statusCode} ${res.body}`)
  return (res.json() as { id: string }).id
}

/** A TipTap document with a paragraph and one image node per attachment id. */
export const docWithImages = (...aids: string[]) => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'pics' }] },
    ...aids.map((aid) => ({ type: 'image', attrs: { src: `attachment://${aid}` } })),
  ],
})

/** A TipTap document with a paragraph and one file node (PDF/GPX) per attachment id. */
export const docWithFiles = (...aids: string[]) => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'files' }] },
    ...aids.map((aid) => ({ type: 'attachmentFile', attrs: { src: `attachment://${aid}`, name: 'file', size: 1, kind: 'pdf' } })),
  ],
})
