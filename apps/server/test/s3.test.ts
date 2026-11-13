// The S3 client used for off-site backups, run against a local in-process HTTP server that plays the S3
// API (never real R2): it records each request and answers per test, including errors and hangs.
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { AwsV4Signer } from 'aws4fetch'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteObject,
  getObjectStream,
  listObjects,
  MAX_PUT_BYTES,
  putObjectFromFile,
  S3Error,
  type S3Target,
} from '../src/services/s3.js'

const ACCESS_KEY_ID = 'AKIDTESTKEY123'
const SECRET = 'very-secret-access-key-value'
const BUCKET = 'test-bucket'

interface Recorded {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
}

type Handler = (req: Recorded, res: ServerResponse) => void

let server: Server
let handler: Handler
let requests: Recorded[]
let target: S3Target
let dir: string

/** Starts a server whose requests are recorded (body read in full) and answered by `handler`. */
async function startServer(): Promise<Server> {
  const s = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) }
      requests.push(recorded)
      handler(recorded, res)
    })
  })
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  return s
}

beforeEach(async () => {
  requests = []
  handler = (_req, res) => res.writeHead(200).end()
  server = await startServer()
  const { port } = server.address() as AddressInfo
  target = {
    endpoint: new URL(`http://127.0.0.1:${port}`),
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET,
    region: 'auto',
    timeoutMs: 300,
  }
  dir = mkdtempSync(path.join(os.tmpdir(), 'notes-s3-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

function writeFile(name: string, data: Buffer): string {
  const file = path.join(dir, name)
  writeFileSync(file, data)
  return file
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function s3ErrorXml(code: string, message: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<Error><Code>${code}</Code><Message>${message}</Message>` +
    '<StringToSign>AWS4-HMAC-SHA256 secret-ish details</StringToSign><RequestId>abc</RequestId></Error>'
  )
}

/**
 * Re-signs the recorded request with the same date and signed headers and checks the result matches the
 * `authorization` header it carried: proves the path and query that were signed are the ones that were
 * sent (an encoding mismatch would fail on real S3/R2).
 */
async function expectValidSignature(req: Recorded): Promise<void> {
  const auth = String(req.headers.authorization)
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(';') ?? []
  const headers: Record<string, string> = {}
  for (const name of signedHeaders) {
    if (name !== 'host') headers[name] = String(req.headers[name])
  }
  const signer = new AwsV4Signer({
    method: req.method,
    url: `${target.endpoint.origin}${req.url}`,
    headers,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET,
    service: 's3',
    region: 'auto',
    datetime: String(req.headers['x-amz-date']),
  })
  const signed = await signer.sign()
  expect(signed.headers.get('authorization')).toBe(auth)
}

function expectSigned(req: Recorded): void {
  expect(req.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD')
  expect(req.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
  const auth = String(req.headers.authorization)
  expect(auth).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY_ID}/\\d{8}/auto/s3/aws4_request, `))
  expect(auth).toContain('SignedHeaders=')
  expect(auth).toMatch(/Signature=[0-9a-f]{64}$/)
}

describe('putObjectFromFile', () => {
  it('sends a signed path-style PUT with the exact file bytes', async () => {
    const data = randomBytes(3 * 1024 * 1024 + 123)
    const file = writeFile('notes.db', data)
    const key = 'notes-backups/notes-backup-20261113-010203/notes.db'

    await putObjectFromFile(target, key, file, 'application/vnd.sqlite3')

    expect(requests).toHaveLength(1)
    const req = requests[0]!
    expect(req.method).toBe('PUT')
    expect(req.url).toBe(`/${BUCKET}/${key}`)
    expect(req.headers['content-length']).toBe(String(data.length))
    expect(req.headers['content-type']).toBe('application/vnd.sqlite3')
    expectSigned(req)
    expect(createHash('sha256').update(req.body).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'))
    await expectValidSignature(req)
  })

  it('encodes the key per path segment and signs what it sends', async () => {
    const file = writeFile('x', Buffer.from('hello'))
    await putObjectFromFile(target, 'my prefix/a+b=c&d.txt', file, 'text/plain')
    expect(requests[0]!.url).toBe(`/${BUCKET}/my%20prefix/a%2Bb%3Dc%26d.txt`)
    await expectValidSignature(requests[0]!)
  })

  it('uploads an empty file', async () => {
    const file = writeFile('empty', Buffer.alloc(0))
    await putObjectFromFile(target, 'k/empty', file, 'application/gzip')
    expect(requests[0]!.headers['content-length']).toBe('0')
    expect(requests[0]!.body).toHaveLength(0)
  })

  it('refuses unsafe keys before any request', async () => {
    const file = writeFile('x', Buffer.from('x'))
    for (const key of ['', '/abs', 'a//b', 'a/../b', './a', 'a/.']) {
      await expect(putObjectFromFile(target, key, file, 'text/plain')).rejects.toThrow(/key/)
    }
    expect(requests).toHaveLength(0)
  })

  it('refuses a file larger than 5 GiB before any request', async () => {
    const file = writeFile('big', Buffer.from('small on disk'))
    const real = fsp.stat
    vi.spyOn(fsp, 'stat').mockImplementation(async (p, opts) => {
      const stats = await real(p, opts)
      return Object.assign(stats, { size: MAX_PUT_BYTES + 1 })
    })
    const error = await putObjectFromFile(target, 'k/big', file, 'application/gzip').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(S3Error)
    expect(error).toMatchObject({ code: 'EntityTooLarge' })
    expect(requests).toHaveLength(0)
  })

  it('reports the response of a server that answers before taking the whole body', async () => {
    // a raw server that answers as soon as the request starts and then reads (and drops) the rest of the
    // body, as S3 does for an early 403; Node's http server would reset the connection instead
    const xml = s3ErrorXml('AccessDenied', 'Access Denied')
    const sockets = new Set<Socket>()
    const early = createNetServer((socket) => {
      sockets.add(socket)
      socket.once('data', () => {
        socket.write(`HTTP/1.1 403 Forbidden\r\ncontent-type: application/xml\r\ncontent-length: ${Buffer.byteLength(xml)}\r\n\r\n${xml}`)
      })
      socket.resume()
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => early.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = early.address() as AddressInfo
      const earlyTarget = { ...target, endpoint: new URL(`http://127.0.0.1:${port}`) }
      const file = writeFile('big', randomBytes(8 * 1024 * 1024))
      const error = await putObjectFromFile(earlyTarget, 'k/big', file, 'application/gzip').catch((e: unknown) => e)
      expect(error).toBeInstanceOf(S3Error)
      expect(error).toMatchObject({ status: 403, code: 'AccessDenied' })
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => early.close(() => resolve()))
    }
  })

  it('fails when the file cannot be read after its size was taken', async () => {
    // a directory stats fine but fails on the first read, like a file removed or unreadable mid-upload
    const unreadable = path.join(dir, 'gone')
    await fsp.mkdir(unreadable)
    await expect(putObjectFromFile(target, 'k/gone', unreadable, 'application/gzip')).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })
})

describe('getObjectStream', () => {
  it('streams the body and reports its length', async () => {
    const data = randomBytes(1024 * 1024 + 7)
    handler = (_req, res) => {
      res.writeHead(200, { 'content-length': String(data.length), 'content-type': 'application/gzip' })
      // several writes, so the client sees the body in pieces
      res.write(data.subarray(0, 1000))
      setTimeout(() => res.end(data.subarray(1000)), 20)
    }
    const { body, contentLength } = await getObjectStream(target, 'p/notes-backup-20261113-010203/uploads.tar.gz')
    expect(contentLength).toBe(data.length)
    expect((await readStream(body)).equals(data)).toBe(true)

    const req = requests[0]!
    expect(req.method).toBe('GET')
    expect(req.url).toBe(`/${BUCKET}/p/notes-backup-20261113-010203/uploads.tar.gz`)
    expectSigned(req)
    await expectValidSignature(req)
  })

  it('reports a null length when the server sends none', async () => {
    handler = (_req, res) => {
      res.writeHead(200)
      res.end('chunked')
    }
    const { body, contentLength } = await getObjectStream(target, 'k')
    expect(contentLength).toBeNull()
    expect((await readStream(body)).toString()).toBe('chunked')
  })
})

describe('listObjects', () => {
  function page(contents: string, next?: string): string {
    return (
      '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>test-bucket</Name>' +
      contents +
      (next ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${next}</NextContinuationToken>` : '<IsTruncated>false</IsTruncated>') +
      '</ListBucketResult>'
    )
  }

  function entry(key: string, size: number, modified: string): string {
    return `<Contents><Key>${key}</Key><LastModified>${modified}</LastModified><ETag>&quot;x&quot;</ETag><Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`
  }

  it('follows continuation tokens and unescapes keys', async () => {
    const token = 'tok+/=1&2'
    handler = (req, res) => {
      const url = new URL(req.url, 'http://x')
      res.writeHead(200, { 'content-type': 'application/xml' })
      if (!url.searchParams.has('continuation-token')) {
        res.end(page(entry('notes backups/a&amp;b.db', 10, '2026-11-12T01:02:03.000Z'), 'tok+/=1&amp;2'))
      } else {
        res.end(page(entry('notes backups/c&lt;d&#62;&#x41;', 20, '2026-11-13T04:05:06.000Z')))
      }
    }

    const objects = await listObjects(target, 'notes backups/')

    expect(objects).toEqual(['notes backups/a&b.db', 'notes backups/c<d>A'])
    expect(requests).toHaveLength(2)
    const first = new URL(requests[0]!.url, 'http://x')
    expect(first.pathname).toBe(`/${BUCKET}`)
    expect(first.searchParams.get('list-type')).toBe('2')
    expect(first.searchParams.get('prefix')).toBe('notes backups/')
    expect(first.searchParams.has('continuation-token')).toBe(false)
    const second = new URL(requests[1]!.url, 'http://x')
    expect(second.searchParams.get('continuation-token')).toBe(token)
    for (const req of requests) {
      expectSigned(req)
      await expectValidSignature(req)
    }
  })

  it('returns an empty list for an empty prefix listing', async () => {
    handler = (_req, res) => res.writeHead(200).end(page(''))
    expect(await listObjects(target, 'none/')).toEqual([])
  })

  it('refuses a truncated listing without a next token', async () => {
    handler = (_req, res) => res.writeHead(200).end(page('').replace('false', 'true'))
    await expect(listObjects(target, 'p/')).rejects.toMatchObject({ code: 'InvalidResponse' })
  })

  it('refuses a listing that repeats its continuation token', async () => {
    handler = (_req, res) => res.writeHead(200).end(page(entry('p/a', 1, '2026-11-12T01:02:03.000Z'), 'same'))
    await expect(listObjects(target, 'p/')).rejects.toMatchObject({ code: 'InvalidResponse' })
    expect(requests.length).toBeLessThanOrEqual(2)
  })

  it('reads only the keys: an odd size or date on any entry does not stop the listing', async () => {
    handler = (_req, res) => res.writeHead(200).end(page(entry('p/a', -1, 'yesterday') + entry('p/b', 1, '')))
    expect(await listObjects(target, 'p/')).toEqual(['p/a', 'p/b'])
  })

  it('refuses an entry without a key', async () => {
    handler = (_req, res) => res.writeHead(200).end(page('<Contents><Size>1</Size></Contents>'))
    await expect(listObjects(target, 'p/')).rejects.toMatchObject({ code: 'InvalidResponse' })
  })

  it('refuses a listing body over its size limit', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end(page(entry('p/a', 1, '2026-11-12T01:02:03.000Z').repeat(Math.ceil((8 * 1024 * 1024) / 150) + 10)))
    }
    await expect(listObjects(target, 'p/')).rejects.toMatchObject({ code: 'InvalidResponse' })
  })
})

describe('deleteObject', () => {
  it.each([200, 204, 404])('treats %i as deleted', async (status) => {
    handler = (_req, res) => res.writeHead(status).end(status === 404 ? s3ErrorXml('NoSuchKey', 'gone') : undefined)
    await expect(deleteObject(target, 'p/notes-backup-20261113-010203/notes.db')).resolves.toBeUndefined()
    expect(requests[0]!.method).toBe('DELETE')
    expect(requests[0]!.url).toBe(`/${BUCKET}/p/notes-backup-20261113-010203/notes.db`)
    expectSigned(requests[0]!)
    await expectValidSignature(requests[0]!)
  })

  it('rejects other statuses', async () => {
    handler = (_req, res) => res.writeHead(500).end(s3ErrorXml('InternalError', 'We encountered an internal error.'))
    await expect(deleteObject(target, 'k')).rejects.toMatchObject({ status: 500, code: 'InternalError' })
  })
})

describe('errors', () => {
  it('turns an S3 XML error into an S3Error without credentials or signature', async () => {
    handler = (_req, res) => res.writeHead(403, { 'content-type': 'application/xml' }).end(s3ErrorXml('AccessDenied', 'Access Denied'))
    const file = writeFile('x', Buffer.from('data'))
    const error = await putObjectFromFile(target, 'k/x', file, 'text/plain').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(S3Error)
    expect(error).toMatchObject({ status: 403, code: 'AccessDenied' })
    const message = (error as Error).message
    expect(message).toContain('Access Denied')
    expect(message).toContain('AccessDenied')
    for (const secret of [SECRET, ACCESS_KEY_ID, 'Signature', 'AWS4-HMAC-SHA256', 'StringToSign']) {
      expect(message).not.toContain(secret)
    }
    expect(JSON.stringify(error)).not.toContain(SECRET)
  })

  it('reads only the start of a huge error body', async () => {
    handler = (_req, res) => {
      res.writeHead(500)
      res.end(s3ErrorXml('SlowDown', 'Reduce your request rate.') + 'x'.repeat(5 * 1024 * 1024))
    }
    await expect(deleteObject(target, 'k')).rejects.toMatchObject({ status: 500, code: 'SlowDown' })
  })

  it('maps a 404 on GET to NoSuchKey, with or without an XML body', async () => {
    handler = (_req, res) => res.writeHead(404).end(s3ErrorXml('NoSuchKey', 'The specified key does not exist.'))
    await expect(getObjectStream(target, 'missing')).rejects.toMatchObject({ status: 404, code: 'NoSuchKey' })
    handler = (_req, res) => res.writeHead(404).end()
    await expect(getObjectStream(target, 'missing')).rejects.toMatchObject({ status: 404, code: 'NoSuchKey' })
  })

  it('uses an HTTP code when the error body is not S3 XML', async () => {
    handler = (_req, res) => res.writeHead(502).end('<html>bad gateway</html>')
    await expect(listObjects(target, 'p/')).rejects.toMatchObject({ status: 502, code: 'HTTP502' })
  })

  it('rejects when the connection is refused', async () => {
    const closed = await startServer()
    const { port } = closed.address() as AddressInfo
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const refused = { ...target, endpoint: new URL(`http://127.0.0.1:${port}`) }
    await expect(getObjectStream(refused, 'k')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    await expect(deleteObject(refused, 'k')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  describe('a server that hangs', () => {
    beforeEach(() => {
      handler = () => {
        /* never answers */
      }
    })

    it('times out every call', async () => {
      const file = writeFile('x', Buffer.from('data'))
      const calls = [
        () => putObjectFromFile(target, 'k/x', file, 'text/plain'),
        () => getObjectStream(target, 'k'),
        () => listObjects(target, 'p/'),
        () => deleteObject(target, 'k'),
      ]
      for (const call of calls) {
        const error = await call().catch((e: unknown) => e)
        expect(error).toBeInstanceOf(S3Error)
        expect(error).toMatchObject({ status: 0, code: 'Timeout' })
      }
    })

    it('times out a download whose body stalls', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-length': '100' })
        res.write('partial')
      }
      const { body } = await getObjectStream(target, 'k')
      await expect(readStream(body)).rejects.toMatchObject({ code: 'Timeout' })
    })

    it('aborts every call through its AbortSignal', async () => {
      const file = writeFile('x', Buffer.from('data'))
      const calls = [
        (signal: AbortSignal) => putObjectFromFile(target, 'k/x', file, 'text/plain', signal),
        (signal: AbortSignal) => getObjectStream(target, 'k', signal),
        (signal: AbortSignal) => listObjects(target, 'p/', signal),
        (signal: AbortSignal) => deleteObject(target, 'k', signal),
      ]
      for (const call of calls) {
        const controller = new AbortController()
        const pending = call(controller.signal).catch((e: unknown) => e)
        setTimeout(() => controller.abort(), 30)
        expect(await pending).toMatchObject({ name: 'AbortError' })
      }
      // a signal that is already aborted sends nothing (the aborted requests above may still be arriving)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const before = requests.length
      const aborted = AbortSignal.abort()
      for (const call of calls) {
        await expect(call(aborted)).rejects.toMatchObject({ name: 'AbortError' })
      }
      expect(requests.length).toBe(before)
    })

    it('aborts a download mid-body', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-length': '100' })
        res.write('partial')
      }
      const controller = new AbortController()
      const { body } = await getObjectStream({ ...target, timeoutMs: 10_000 }, 'k', controller.signal)
      const reading = readStream(body).catch((e: unknown) => e)
      setTimeout(() => controller.abort(), 30)
      expect(await reading).toMatchObject({ name: 'AbortError' })
    })
  })
})
