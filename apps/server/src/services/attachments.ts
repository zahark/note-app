// Attachment lifecycle: upload (content-based type detection, per-kind size limit, random on-disk
// name), `note_attachments` sync on content save, and the sweep that deletes files nothing has
// referenced for 7 days. Three kinds are accepted: images (PNG/JPEG/WebP/GIF), PDF and GPX.
//
// Attachments belong to the user, not to a note. A note's references are rebuilt from its content on
// every content save; deleting a note or folder only removes references (FK cascade, and the
// `note_attachments_unlinked` trigger stamps `last_unlinked_at`). Files are deleted only by the sweep.
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Db } from '../db/index.js'
import { AppError, unsupportedMediaType } from '../errors.js'
import {
  attachmentBytesUsed,
  createAttachment,
  setNoteAttachments,
  type AttachmentRow,
} from '../repos/attachments.js'
import { saveNoteContent, type SaveContentResult } from '../repos/notes.js'
import { deleteSweepableAttachments, listAllStorageNames } from '../repos/publicShare.js'
import { DAY_SEC, HOUR_SEC, KIB, MIB, MINUTE_MS } from '../units.js'

/** Largest accepted image. */
export const MAX_IMAGE_BYTES = 10 * MIB

/** Largest accepted PDF or GPX file. */
export const MAX_FILE_BYTES = 25 * MIB

/** Largest accepted upload of any kind (the multipart limit); the per-kind limit is checked after detection. */
export const MAX_UPLOAD_BYTES = Math.max(MAX_IMAGE_BYTES, MAX_FILE_BYTES)

/**
 * Upload rate limit per account: generous enough for pasting a large batch of screenshots, while
 * bounding how fast one account can fill the disk (together with the per-account storage quota).
 */
export const UPLOAD_LIMIT = { limit: 100, windowMs: 15 * MINUTE_MS } as const

/** An unreferenced attachment is swept this long after it lost its last reference (or was uploaded). */
export const SWEEP_GRACE_SEC = 7 * DAY_SEC

/** A file in the uploads directory with no row is deleted only once it is this old. */
export const STRAY_GRACE_SEC = HOUR_SEC

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export type AttachmentKind = 'image' | 'pdf' | 'gpx'

export type AttachmentMime = ImageMime | 'application/pdf' | 'application/gpx+xml'

export interface DetectedType {
  kind: AttachmentKind
  mime: AttachmentMime
}

/**
 * Per-kind upload limit, display label for error messages, file-name fallback, and the extension a
 * stored file's name is forced to end in at upload (none for images: their names are kept as uploaded,
 * and their served name gets its extension from the detected image type, see `IMAGE_EXTENSIONS`).
 */
const KINDS: Record<AttachmentKind, { maxBytes: number; label: string; fallbackName: string; extension: string }> = {
  image: { maxBytes: MAX_IMAGE_BYTES, label: 'Images', fallbackName: 'image', extension: '' },
  pdf: { maxBytes: MAX_FILE_BYTES, label: 'PDF files', fallbackName: 'document.pdf', extension: '.pdf' },
  gpx: { maxBytes: MAX_FILE_BYTES, label: 'GPX files', fallbackName: 'track.gpx', extension: '.gpx' },
}

/** The download extension of each non-image stored mime (see `attachmentResponseHeaders`). */
const MIME_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['application/pdf', KINDS.pdf.extension],
  ['application/gpx+xml', KINDS.gpx.extension],
])

/**
 * The extensions a served image's name may end in, per type; the first is appended when it ends in
 * none of them (see `attachmentResponseHeaders`).
 */
const IMAGE_EXTENSIONS: ReadonlyMap<string, readonly string[]> = new Map<ImageMime, readonly string[]>([
  ['image/png', ['.png']],
  ['image/jpeg', ['.jpg', '.jpeg']],
  ['image/webp', ['.webp']],
  ['image/gif', ['.gif']],
])

/** Longest stored file name, in UTF-16 code units. */
const MAX_NAME_LENGTH = 255

/**
 * `name` made to end in `extension` (case-insensitive), so a saved download always opens as the
 * kind that was detected: the extension is appended, never substituted, so the rest of the name stays
 * as the user wrote it ("Route guide.exe" → "Route guide.exe.pdf"). The result is capped at
 * `MAX_NAME_LENGTH` with the extension kept. Idempotent; an empty `extension` returns `name` as is.
 */
export function withExtension(name: string, extension: string): string {
  if (!extension || name.toLowerCase().endsWith(extension)) return name
  return name.slice(0, MAX_NAME_LENGTH - extension.length) + extension
}

/**
 * `name` made to end in one of `extensions` (case-insensitive): the first is appended (`withExtension`)
 * when it ends in none.
 */
function withOneOfExtensions(name: string, extensions: readonly string[]): string {
  const lower = name.toLowerCase()
  if (extensions.some((extension) => lower.endsWith(extension))) return name
  return withExtension(name, extensions[0] ?? '')
}

/** The GPX sniff looks at this many leading bytes (the DOCTYPE/ENTITY check covers all of them). */
export const GPX_SNIFF_BYTES = 64 * KIB

/** RFC 8187 `attr-char`: the bytes a `filename*` value may carry unencoded. */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/

/**
 * A `Content-Disposition` value (`attachment` unless `type` says `inline`) naming the file `name`:
 * `filename*` carries the exact name (UTF-8, percent-encoded; a lone surrogate becomes U+FFFD),
 * `filename` an ASCII fallback with everything but printable ASCII, and `"`, `\`, `%`, `;`, `*`, `=`,
 * `'`, replaced by `_`. Neither part can break out of its parameter or inject a header, and the
 * fallback can never look like another parameter (`filename*=UTF-8''…`) to a lenient parser.
 */
export function contentDisposition(name: string, type: 'attachment' | 'inline' = 'attachment'): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;*=']/g, '_')
  const encoded = [...Buffer.from(name, 'utf8')]
    .map((b) => {
      const c = String.fromCharCode(b)
      return ATTR_CHAR.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`
    })
    .join('')
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/**
 * Response headers for serving an attachment's bytes (owner and shared routes alike); the file name
 * a browser or the web client saves always comes from here, never from the note content. Images are
 * served inline with their type and `nosniff`, named after `original_name` made to end in the detected
 * type's extension (`IMAGE_EXTENSIONS`: `x.js` → `x.js.png`). Every other kind (PDF, GPX, anything not
 * a known image type) is always a download named after `original_name`, sandboxed by its own CSP, so
 * opening the file URL directly can never render it on the app's origin. A PDF or GPX download name
 * always ends in `.pdf` / `.gpx` (`withExtension`; upload already stores it that way, this also covers
 * older rows).
 */
export function attachmentResponseHeaders(attachment: { mime: string; original_name: string }): Record<string, string> {
  const headers = { 'content-type': attachment.mime, 'x-content-type-options': 'nosniff' }
  const imageExtensions = IMAGE_EXTENSIONS.get(attachment.mime)
  if (imageExtensions) {
    return {
      ...headers,
      'content-disposition': contentDisposition(withOneOfExtensions(attachment.original_name, imageExtensions), 'inline'),
    }
  }
  return {
    ...headers,
    'content-disposition': contentDisposition(
      withExtension(attachment.original_name, MIME_EXTENSIONS.get(attachment.mime) ?? ''),
    ),
    'content-security-policy': 'sandbox',
  }
}

/** Directory holding the uploaded files. */
export const uploadsDir = (dataDir: string): string => path.join(dataDir, 'uploads')

/** The bytes of the uploaded file `storageName`, or undefined when it cannot be read (e.g. missing). */
export async function readAttachmentFile(dataDir: string, storageName: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path.join(uploadsDir(dataDir), storageName))
  } catch {
    return undefined
  }
}

const startsWith = (buf: Buffer, bytes: number[], offset = 0): boolean =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b)

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/**
 * Detects the image type from the file's magic bytes. Only PNG, JPEG, WebP and GIF are accepted
 * (no SVG: it can carry script). Returns null for anything else.
 */
export function detectImageMime(buf: Buffer): ImageMime | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return 'image/webp'
  return null
}

const isXmlSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\n'

/**
 * True when `buf` looks like a GPX document: UTF-8 text (an optional BOM is skipped) whose first
 * element, after whitespace, an optional XML declaration, comments and whitespace, is literally `<gpx`
 * (no namespace prefix; no processing instruction other than the XML declaration). Any `<!DOCTYPE` or
 * `<!ENTITY` in the first `GPX_SNIFF_BYTES` rejects the file (no DTDs, so no entity expansion if
 * anything ever parses it). A scanner, not a regex, so the check stays linear on hostile input.
 */
export function isGpx(buf: Buffer): boolean {
  let text: string
  try {
    // `stream: true` tolerates a multi-byte character cut at the end of the sniffed prefix
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, GPX_SNIFF_BYTES), { stream: true })
  } catch {
    return false
  }
  if (/<!(?:DOCTYPE|ENTITY)/i.test(text)) return false
  let i = 0
  // leading whitespace before the declaration is ill-formed XML, but some exporters write it
  while (isXmlSpace(text[i])) i++
  if (text.startsWith('<?xml', i) && isXmlSpace(text[i + 5])) {
    const end = text.indexOf('?>', i + 5)
    if (end < 0) return false
    i = end + 2
  }
  for (;;) {
    while (isXmlSpace(text[i])) i++
    if (!text.startsWith('<!--', i)) break
    const end = text.indexOf('-->', i + 4)
    if (end < 0) return false
    i = end + 3
  }
  const next = text[i + 4]
  return text.startsWith('<gpx', i) && (isXmlSpace(next) || next === '>' || next === '/')
}

/**
 * Detects what an upload is from its content alone (never from the declared type or the extension):
 * an image by magic bytes, a PDF by `%PDF-` at offset 0 (readers also accept the header after some
 * leading junk, but that would let a Windows/ELF/Mach-O executable whose stub carries `%PDF-` pass as
 * a PDF), a GPX by `isGpx`. Returns null for anything else.
 */
export function detectAttachmentKind(buf: Buffer): DetectedType | null {
  const image = detectImageMime(buf)
  if (image) return { kind: 'image', mime: image }
  if (startsWith(buf, ascii('%PDF-'))) return { kind: 'pdf', mime: 'application/pdf' }
  if (isGpx(buf)) return { kind: 'gpx', mime: 'application/gpx+xml' }
  return null
}

const unsupported = () =>
  unsupportedMediaType('Only PNG, JPEG, WebP and GIF images, PDF files and GPX tracks are allowed')

export interface UploadInput {
  /** Client-supplied file name; display only, never used in a path. */
  originalName: string
  data: Buffer
}

/** 413 `QUOTA_EXCEEDED`: storing this file would take the account past `UPLOAD_QUOTA_MB`. */
export const quotaExceeded = (quotaMb: number) =>
  new AppError(
    413,
    'QUOTA_EXCEEDED',
    `Attachment storage is full (${quotaMb} MB per account). Remove images and files you no longer ` +
      `need from your notes; their space is freed ${SWEEP_GRACE_SEC / DAY_SEC} days after removal`,
  )

/**
 * Throws `quotaExceeded` when the user's stored attachments plus `incomingBytes` would exceed the quota
 * (`quotaMb` 0 = no limit). Counts every stored file of every kind, including unreferenced ones
 * awaiting the sweep.
 */
export function assertWithinQuota(db: Db, userId: string, quotaMb: number, incomingBytes: number): void {
  if (quotaMb <= 0) return
  if (attachmentBytesUsed(db, userId) + incomingBytes > quotaMb * MIB) throw quotaExceeded(quotaMb)
}

/**
 * Validates and stores an upload: detects the kind from the content (the browser-declared type is
 * ignored: it comes from the file extension, which is often wrong; the detected type is what gets
 * stored), checks that kind's size limit (`MAX_IMAGE_BYTES` / `MAX_FILE_BYTES`), writes
 * the bytes under a random `storage_name`, then checks the quota and inserts the row (with
 * `last_unlinked_at` NULL) in one synchronous step, so parallel uploads cannot together overshoot it.
 * If the quota check or the insert fails the file is removed again; a file left behind by a crash is a
 * stray the sweep removes. `quotaMb` is the per-account limit in MiB (0 = no limit). Returns the new
 * row plus the detected kind.
 */
export async function storeUpload(
  db: Db,
  dataDir: string,
  userId: string,
  input: UploadInput,
  quotaMb = 0,
): Promise<AttachmentRow & { kind: AttachmentKind }> {
  const detected = detectAttachmentKind(input.data)
  if (!detected) throw unsupported()
  const { kind, mime } = detected
  const { maxBytes, label } = KINDS[kind]
  if (input.data.length > maxBytes) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', `${label} are limited to ${maxBytes / MIB} MB`)
  }

  const dir = uploadsDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const storageName = randomBytes(16).toString('hex')
  const file = path.join(dir, storageName)
  await writeFile(file, input.data, { flag: 'wx' })
  try {
    assertWithinQuota(db, userId, quotaMb, input.data.length)
    const row = createAttachment(db, userId, {
      originalName: displayName(input.originalName, kind),
      storageName,
      mime,
      size: input.data.length,
    })
    return { ...row, kind }
  } catch (err) {
    await rm(file, { force: true })
    throw err
  }
}

/**
 * Keeps the last path segment of a client file name, capped at `MAX_NAME_LENGTH` chars; falls back per
 * kind to "image", "document.pdf" or "track.gpx". A PDF or GPX name is made to end in `.pdf` / `.gpx`
 * (`withExtension`), so the stored name, the upload response, the editor node and every download agree
 * and the saved file opens as the kind that was checked.
 */
function displayName(name: string, kind: AttachmentKind): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? ''
  return withExtension(base.slice(0, MAX_NAME_LENGTH) || KINDS[kind].fallbackName, KINDS[kind].extension)
}

const ATTACHMENT_REF = /^attachment:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * Every attachment id referenced by a TipTap document: any string value in the JSON that is exactly
 * `attachment://<uuid>` (in practice an image or file node's `src`). Deduplicated, lower-cased.
 */
export function extractAttachmentIds(content: unknown): string[] {
  const ids = new Set<string>()
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      const m = ATTACHMENT_REF.exec(value)
      if (m) ids.add(m[1]!.toLowerCase())
    } else if (Array.isArray(value)) {
      for (const v of value) walk(v)
    } else if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value)) walk(v)
    }
  }
  walk(content)
  return [...ids]
}

/**
 * Content save plus `note_attachments` sync in one transaction: on a successful (version-matched)
 * save, the note's references become exactly the caller's own attachments named in the content.
 */
export function saveContentWithAttachments(
  db: Db,
  userId: string,
  noteId: string,
  content: unknown,
  expectedVersion: number,
): SaveContentResult {
  const save = db.transaction((): SaveContentResult => {
    const result = saveNoteContent(db, userId, noteId, content, expectedVersion)
    if (result.ok) setNoteAttachments(db, userId, noteId, extractAttachmentIds(content))
    return result
  })
  return save.immediate()
}

export interface SweepResult {
  /** Attachment rows (and their files) deleted. */
  attachments: number
  /** Files without a row deleted. */
  strays: number
}

const isMissing = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'

/**
 * Deletes attachments with no `note_attachments` rows whose `MAX(created_at, last_unlinked_at)` is
 * older than `now − 7 days` (rows first, files after the delete has committed), then stray files with
 * no row that are older than 1 hour (so an upload still writing its file or about to insert its row is
 * never touched). `now` is unix seconds, injectable so tests can advance time.
 */
export async function sweepAttachments(db: Db, dataDir: string, now: number): Promise<SweepResult> {
  const dir = uploadsDir(dataDir)
  const deleted = deleteSweepableAttachments(db, now - SWEEP_GRACE_SEC)
  for (const name of deleted) {
    await unlink(path.join(dir, name)).catch((err: unknown) => {
      if (!isMissing(err)) throw err
    })
  }

  let strays = 0
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if (isMissing(err)) return { attachments: deleted.length, strays }
    throw err
  }
  // read the known names after listing the directory, so a file whose row was inserted in between counts as known
  const known = listAllStorageNames(db)
  const strayCutoffMs = (now - STRAY_GRACE_SEC) * 1000
  for (const name of entries) {
    if (known.has(name)) continue
    const file = path.join(dir, name)
    try {
      const st = await stat(file)
      if (!st.isFile() || st.mtimeMs >= strayCutoffMs) continue
      await unlink(file)
      strays++
    } catch (err) {
      if (!isMissing(err)) throw err
    }
  }
  return { attachments: deleted.length, strays }
}
