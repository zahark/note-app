// An in-process HTTP server that plays just enough of the S3 API for the off-site backup tests (never real
// R2): path-style PUT stores an object, GET returns it, ListObjectsV2 lists a prefix, DELETE removes one.
// Every request is recorded; `fail` can answer a chosen request with an error instead.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OffsiteBackupConfig } from '../../src/config.js'

export interface FakeS3Request {
  method: string
  /** Object key (decoded), or `null` for a bucket-level request such as a listing. */
  key: string | null
  query: URLSearchParams
  headers: IncomingMessage['headers']
  body: Buffer
}

export interface FakeS3Object {
  body: Buffer
  contentType: string | undefined
  lastModified: Date
}

/** Answers a request itself (e.g. with an error) when it returns true. */
export type FakeS3Interceptor = (req: FakeS3Request, res: ServerResponse) => boolean

export const FAKE_S3_BUCKET = 'test-bucket'

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export class FakeS3 {
  readonly objects = new Map<string, FakeS3Object>()
  readonly requests: FakeS3Request[] = []
  /** Consulted before every request; return true after answering it. */
  intercept: FakeS3Interceptor = () => false
  private server: Server | undefined

  /** Starts the server on a free local port. */
  async start(): Promise<this> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => this.handle(req, Buffer.concat(chunks), res))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    return this
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  get endpoint(): URL {
    const { port } = this.server!.address() as AddressInfo
    return new URL(`http://127.0.0.1:${port}`)
  }

  /** An off-site backup config aimed at this server (the http endpoint config itself would refuse). */
  config(overrides: Partial<OffsiteBackupConfig> = {}): OffsiteBackupConfig {
    return {
      endpoint: this.endpoint,
      bucket: FAKE_S3_BUCKET,
      accessKeyId: 'AKIDFAKEKEY',
      secretAccessKey: 'fake-secret-access-key-value',
      region: 'auto',
      prefix: 'notes-backups/',
      intervalMs: 24 * 60 * 60 * 1000,
      keepDays: 30,
      ...overrides,
    }
  }

  /** Stores an object directly (test setup). */
  put(key: string, body: Buffer | string = '', lastModified = new Date()): void {
    this.objects.set(key, { body: Buffer.from(body), contentType: undefined, lastModified })
  }

  /** The keys of every stored object, sorted. */
  keys(): string[] {
    return [...this.objects.keys()].sort()
  }

  private handle(req: IncomingMessage, body: Buffer, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://fake')
    const [, bucket = '', ...rest] = url.pathname.split('/')
    const key = rest.length === 0 ? null : rest.map(decodeURIComponent).join('/')
    const recorded: FakeS3Request = { method: req.method ?? '', key, query: url.searchParams, headers: req.headers, body }
    this.requests.push(recorded)
    if (this.intercept(recorded, res)) return
    if (decodeURIComponent(bucket) !== FAKE_S3_BUCKET) return this.error(res, 404, 'NoSuchBucket')

    if (key === null) {
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') return this.list(url.searchParams, res)
      return this.error(res, 400, 'InvalidRequest')
    }
    switch (req.method) {
      case 'PUT':
        this.objects.set(key, { body, contentType: req.headers['content-type'], lastModified: new Date() })
        res.writeHead(200, { etag: '"x"' }).end()
        return
      case 'GET': {
        const object = this.objects.get(key)
        if (!object) return this.error(res, 404, 'NoSuchKey')
        res.writeHead(200, { 'content-length': object.body.length }).end(object.body)
        return
      }
      case 'DELETE':
        this.objects.delete(key)
        res.writeHead(204).end()
        return
      default:
        this.error(res, 405, 'MethodNotAllowed')
    }
  }

  private list(query: URLSearchParams, res: ServerResponse): void {
    const prefix = query.get('prefix') ?? ''
    const contents = this.keys()
      .filter((key) => key.startsWith(prefix))
      .map((key) => {
        const object = this.objects.get(key)!
        return (
          `<Contents><Key>${escapeXml(key)}</Key><LastModified>${object.lastModified.toISOString()}</LastModified>` +
          `<Size>${object.body.length}</Size></Contents>`
        )
      })
      .join('')
    res
      .writeHead(200, { 'content-type': 'application/xml' })
      .end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${FAKE_S3_BUCKET}</Name>` +
          `${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
      )
  }

  /** Answers with an S3 XML error. */
  error(res: ServerResponse, status: number, code: string, message = code): void {
    res
      .writeHead(status, { 'content-type': 'application/xml' })
      .end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`)
  }
}
