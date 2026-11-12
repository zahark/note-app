// Attachment lifecycle: upload (magic-byte check, random on-disk name), `note_attachments` sync on
// content save, and the sweep that deletes images nothing has referenced for 7 days.
//
// Attachments belong to the user, not to a note. A note's references are rebuilt from its content on
// every content save; deleting a note or folder only removes references (FK cascade, and the
// `note_attachments_unlinked` trigger stamps `last_unlinked_at`). Images are deleted only by the sweep.
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
import { DAY_SEC, HOUR_SEC, MIB, MINUTE_MS } from '../units.js'

/** Largest accepted upload. */
export const MAX_ATTACHMENT_BYTES = 10 * MIB

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

const unsupported = () => unsupportedMediaType('Only PNG, JPEG, WebP and GIF images are allowed')

export interface UploadInput {
  /** Client-supplied file name; display only, never used in a path. */
  originalName: string
  data: Buffer
}

/** 413 `QUOTA_EXCEEDED`: storing this image would take the account past `UPLOAD_QUOTA_MB`. */
export const quotaExceeded = (quotaMb: number) =>
  new AppError(
    413,
    'QUOTA_EXCEEDED',
    `Image storage is full (${quotaMb} MB per account). Remove images you no longer need from your ` +
      `notes; their space is freed ${SWEEP_GRACE_SEC / DAY_SEC} days after removal`,
  )

/**
 * Throws `quotaExceeded` when the user's stored images plus `incomingBytes` would exceed the quota
 * (`quotaMb` 0 = no limit). Counts every stored image, including unreferenced ones awaiting the sweep.
 */
export function assertWithinQuota(db: Db, userId: string, quotaMb: number, incomingBytes: number): void {
  if (quotaMb <= 0) return
  if (attachmentBytesUsed(db, userId) + incomingBytes > quotaMb * MIB) throw quotaExceeded(quotaMb)
}

/**
 * Validates and stores an upload: checks size and magic bytes (the browser-declared type is ignored: it
 * comes from the file extension, which is often wrong; the detected type is what gets stored), writes
 * the bytes under a random `storage_name`, then checks the quota and inserts the row (with
 * `last_unlinked_at` NULL) in one synchronous step, so parallel uploads cannot together overshoot it.
 * If the quota check or the insert fails the file is removed again; a file left behind by a crash is a
 * stray the sweep removes. `quotaMb` is the per-account limit in MiB (0 = no limit).
 */
export async function storeUpload(
  db: Db,
  dataDir: string,
  userId: string,
  input: UploadInput,
  quotaMb = 0,
): Promise<AttachmentRow> {
  if (input.data.length > MAX_ATTACHMENT_BYTES) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Images are limited to ${MAX_ATTACHMENT_BYTES / MIB} MB`)
  }
  const mime = detectImageMime(input.data)
  if (!mime) throw unsupported()

  const dir = uploadsDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const storageName = randomBytes(16).toString('hex')
  const file = path.join(dir, storageName)
  await writeFile(file, input.data, { flag: 'wx' })
  try {
    assertWithinQuota(db, userId, quotaMb, input.data.length)
    return createAttachment(db, userId, {
      originalName: displayName(input.originalName),
      storageName,
      mime,
      size: input.data.length,
    })
  } catch (err) {
    await rm(file, { force: true })
    throw err
  }
}

/** Keeps the last path segment of a client file name, capped at 255 chars; falls back to "image". */
function displayName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? ''
  return base.slice(0, 255) || 'image'
}

const ATTACHMENT_REF = /^attachment:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * Every attachment id referenced by a TipTap document: any string value in the JSON that is exactly
 * `attachment://<uuid>` (in practice an image node's `src`). Deduplicated, lower-cased.
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
