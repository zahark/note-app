// A minimal S3 client for the off-site backups (Cloudflare R2 in production, a local fake server in tests):
// streamed PUT from a file, streamed GET, ListObjectsV2 and DELETE, nothing else.
//
// Requests are signed with aws4fetch's `AwsV4Signer` (SigV4, `UNSIGNED-PAYLOAD`, so a file is never read
// twice or held in memory) and sent with `node:https` (`node:http` only for a test endpoint; config accepts
// https only). Every call has a connect/idle timeout and an optional `AbortSignal`. Error messages carry
// only the S3 error code and message, never credentials, signatures or signed headers.
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AwsV4Signer } from 'aws4fetch'
import { KIB, MIB, SECOND_MS } from '../units.js'

/** Where objects go: `<endpoint>/<bucket>/<key>` (path-style). `OffsiteBackupConfig` satisfies it. */
export interface S3Target {
  /** API origin, e.g. https://<account-id>.r2.cloudflarestorage.com; any path is ignored. */
  endpoint: URL
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** SigV4 region (`auto` for R2). */
  region: string
  /** Connect/idle timeout per request (default 60 s; tests use a short one). */
  timeoutMs?: number
}

/** Largest object a single PUT may upload (the S3/R2 limit). */
export const MAX_PUT_BYTES = 5 * 1024 * MIB

const DEFAULT_TIMEOUT_MS = 60 * SECOND_MS
/** How much of an error response is read to find its `<Code>` and `<Message>`. */
const ERROR_BODY_BYTES = 2 * KIB
/** A ListObjectsV2 page holds at most 1000 keys; anything far beyond that is not a real listing. */
const LIST_BODY_BYTES = 8 * MIB
const MAX_MESSAGE_LENGTH = 300

/**
 * A failed S3 call: `status` is the HTTP status (0 when no response decided it: a timeout, a refused file
 * or an unreadable response) and `code` the S3 error code (`AccessDenied`, `NoSuchKey`, `Timeout`, ...).
 */
export class S3Error extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(`S3 ${code}${status ? ` (HTTP ${status})` : ''}: ${message}`)
    this.name = 'S3Error'
    this.status = status
    this.code = code
  }
}

/** RFC 3986 percent-encoding (what SigV4 expects): `encodeURIComponent` plus `!'()*`. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** Keys come from validated config and fixed names; still refuse anything a URL parser would rewrite. */
function assertKey(key: string): void {
  const bad =
    key.length === 0 ||
    key.length > 1024 ||
    key.split('/').some((segment, i, all) => (segment === '' && i < all.length - 1) || segment === '.' || segment === '..') ||
    key.startsWith('/')
  if (bad) throw new S3Error(0, 'InvalidKey', 'refusing an empty, absolute or dot-segment object key')
}

function bucketUrl(target: S3Target, query: Record<string, string> = {}): URL {
  const url = new URL(`${target.endpoint.origin}/${encodeRfc3986(target.bucket)}`)
  url.search = Object.entries(query)
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&')
  return url
}

function objectUrl(target: S3Target, key: string): URL {
  assertKey(key)
  const path = key.split('/').map(encodeRfc3986).join('/')
  return new URL(`${target.endpoint.origin}/${encodeRfc3986(target.bucket)}/${path}`)
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new DOMException('This operation was aborted', 'AbortError')
}

interface SendOptions {
  method: 'GET' | 'PUT' | 'DELETE'
  url: URL
  headers?: Record<string, string>
  /** Opens the request body (called only once the request is signed). */
  body?: () => Readable
  signal?: AbortSignal
}

/**
 * Signs and sends one request and resolves with the response as soon as its headers arrive. The timeout
 * and the signal keep applying while the caller reads the response body: either destroys it with a
 * `Timeout` S3Error or the abort reason.
 */
async function send(target: S3Target, { method, url, headers = {}, body, signal }: SendOptions): Promise<IncomingMessage> {
  signal?.throwIfAborted()
  const signed = await new AwsV4Signer({
    method,
    url: url.toString(),
    headers: { ...headers, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    service: 's3',
    region: target.region,
  }).sign()
  signal?.throwIfAborted()

  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const transport = signed.url.protocol === 'https:' ? https : http
  return new Promise<IncomingMessage>((resolve, reject) => {
    let response: IncomingMessage | undefined
    const req = transport.request(signed.url, {
      method,
      headers: Object.fromEntries(signed.headers),
      timeout: timeoutMs,
      // one connection per request: no pooled keep-alive socket outlives a backup run or `app.close()`
      agent: false,
    })
    const fail = (error: Error) => {
      reject(error) // no-op once the response has resolved the promise
      response?.destroy(error)
      req.destroy(error)
    }
    const onAbort = () => fail(abortError(signal!))
    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => signal?.removeEventListener('abort', onAbort))
    req.on('timeout', () => fail(new S3Error(0, 'Timeout', `no data from ${url.host} for ${timeoutMs / SECOND_MS} s`)))
    req.on('error', reject)
    req.on('response', (res) => {
      response = res
      resolve(res)
    })
    if (body) {
      // a server may answer (e.g. 403) before taking the whole body; the response then decides the outcome
      pipeline(body(), req).catch((error: Error) => {
        if (!response) fail(error)
      })
    } else {
      req.end()
    }
  })
}

/** Reads a response body up to `limit` bytes; with `truncate` it stops there instead of failing. */
async function readBody(res: IncomingMessage, limit: number, truncate = false): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of res) {
    const buf = chunk as Buffer
    chunks.push(buf)
    total += buf.length
    if (total >= limit) {
      if (!truncate) throw new S3Error(0, 'InvalidResponse', `response body larger than ${limit} bytes`)
      break // leaving the loop destroys the response
    }
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8')
}

async function drain(res: IncomingMessage): Promise<void> {
  for await (const _chunk of res) {
    // discard
  }
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return XML_ENTITIES[entity] ?? whole
  })
}

/** The unescaped text of the first `<tag>…</tag>` in `xml` (elements here never nest themselves). */
function xmlText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  return match?.[1] === undefined ? undefined : unescapeXml(match[1])
}

function xmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1] ?? '')
}

/** Builds the S3Error for a non-2xx response from the start of its XML error body. */
async function responseError(res: IncomingMessage, notFoundCode?: string): Promise<S3Error> {
  const status = res.statusCode ?? 0
  const xml = await readBody(res, ERROR_BODY_BYTES, true)
  const code = xmlText(xml, 'Code')?.trim() || (status === 404 && notFoundCode) || `HTTP${status}`
  const message = (xmlText(xml, 'Message') ?? res.statusMessage ?? 'request failed')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH)
  return new S3Error(status, code, message || 'request failed')
}

function isSuccess(res: IncomingMessage): boolean {
  const status = res.statusCode ?? 0
  return status >= 200 && status < 300
}

/** Uploads a file in one streamed PUT (up to 5 GiB) with an explicit `Content-Length`. */
export async function putObjectFromFile(
  target: S3Target,
  key: string,
  filePath: string,
  contentType: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = objectUrl(target, key)
  const { size } = await fsp.stat(filePath)
  if (size > MAX_PUT_BYTES) {
    throw new S3Error(0, 'EntityTooLarge', `${filePath} is ${size} bytes, over the 5 GiB single-upload limit`)
  }
  const res = await send(target, {
    method: 'PUT',
    url,
    headers: { 'content-type': contentType, 'content-length': String(size) },
    body: () => createReadStream(filePath),
    signal,
  })
  if (!isSuccess(res)) throw await responseError(res)
  await drain(res)
}

/**
 * Downloads an object as a stream (the caller must consume or destroy `body`); `contentLength` is the
 * response's `Content-Length`, or `null` when it has none. A missing object rejects with `NoSuchKey`.
 */
export async function getObjectStream(
  target: S3Target,
  key: string,
  signal?: AbortSignal,
): Promise<{ body: Readable; contentLength: number | null }> {
  const res = await send(target, { method: 'GET', url: objectUrl(target, key), signal })
  if (!isSuccess(res)) throw await responseError(res, 'NoSuchKey')
  const header = res.headers['content-length']
  const length = header === undefined ? NaN : Number(header)
  return { body: res, contentLength: Number.isSafeInteger(length) && length >= 0 ? length : null }
}

function parseKey(block: string): string {
  const key = xmlText(block, 'Key')
  if (key === undefined) throw new S3Error(0, 'InvalidResponse', 'object listing entry without a key')
  return key
}

/** The key of every object under `prefix` (ListObjectsV2, following continuation tokens). */
export async function listObjects(target: S3Target, prefix: string, signal?: AbortSignal): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  for (;;) {
    const query: Record<string, string> = { 'list-type': '2', prefix }
    if (token !== undefined) query['continuation-token'] = token
    const res = await send(target, { method: 'GET', url: bucketUrl(target, query), signal })
    if (!isSuccess(res)) throw await responseError(res)
    const xml = await readBody(res, LIST_BODY_BYTES)
    keys.push(...xmlBlocks(xml, 'Contents').map(parseKey))
    if (xmlText(xml, 'IsTruncated')?.trim() !== 'true') return keys
    const next = xmlText(xml, 'NextContinuationToken')
    if (!next || next === token) {
      throw new S3Error(0, 'InvalidResponse', 'truncated object listing without a new continuation token')
    }
    token = next
  }
}

/** Deletes an object; one that is already gone (404) counts as deleted. */
export async function deleteObject(target: S3Target, key: string, signal?: AbortSignal): Promise<void> {
  const res = await send(target, { method: 'DELETE', url: objectUrl(target, key), signal })
  if (res.statusCode === 404) {
    res.destroy()
    return
  }
  if (!isSuccess(res)) throw await responseError(res)
  await drain(res)
}
