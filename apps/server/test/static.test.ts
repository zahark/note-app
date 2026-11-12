import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, defaultWebDir } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { openDb, type Db } from '../src/db/index.js'

const ORIGIN = 'http://localhost:3000'
const config = loadConfig({
  SESSION_SECRET: 'a'.repeat(32),
  SHARE_HMAC_KEY: 'b'.repeat(32),
  PUBLIC_ORIGIN: ORIGIN,
})

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div>spa-shell</body></html>'
const APP_JS = 'console.log("app")'

let tmp: string
let webDir: string
let app: FastifyInstance
let db: Db

beforeEach(() => {
  // <tmp>/web is the static root; <tmp>/secret.txt sits outside it to check traversal
  tmp = mkdtempSync(path.join(os.tmpdir(), 'notes-static-'))
  webDir = path.join(tmp, 'web')
  mkdirSync(path.join(webDir, 'assets'), { recursive: true })
  writeFileSync(path.join(webDir, 'index.html'), INDEX_HTML)
  writeFileSync(path.join(webDir, 'assets', 'app.js'), APP_JS)
  writeFileSync(path.join(webDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(path.join(tmp, 'secret.txt'), 'top secret')
  db = openDb(':memory:')
  app = buildApp({ config, db, webDir })
})

afterEach(async () => {
  await app.close()
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const get = (url: string) => app.inject({ method: 'GET', url })

function expectIndexHtml(res: Awaited<ReturnType<typeof get>>): void {
  expect(res.statusCode).toBe(200)
  expect(res.headers['content-type']).toMatch(/^text\/html/)
  expect(res.body).toBe(INDEX_HTML)
}

function expectJsonNotFound(res: Awaited<ReturnType<typeof get>>): void {
  expect(res.statusCode).toBe(404)
  expect(res.headers['content-type']).toMatch(/^application\/json/)
  expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } })
}

describe('built web assets', () => {
  it('serves index.html at /', async () => {
    expectIndexHtml(await get('/'))
  })

  it('serves existing files with their content type', async () => {
    const js = await get('/assets/app.js')
    expect(js.statusCode).toBe(200)
    expect(js.headers['content-type']).toMatch(/javascript/)
    expect(js.body).toBe(APP_JS)

    const svg = await get('/favicon.svg')
    expect(svg.statusCode).toBe(200)
    expect(svg.headers['content-type']).toMatch(/^image\/svg\+xml/)
  })

  it('marks the HTML shell no-cache so a new deploy is picked up', async () => {
    expect((await get('/')).headers['cache-control']).toBe('no-cache')
    expect((await get('/login')).headers['cache-control']).toBe('no-cache')
  })

  it('a missing file (path with an extension) is a JSON 404, not the SPA shell', async () => {
    expectJsonNotFound(await get('/assets/missing.js'))
    expectJsonNotFound(await get('/robots.txt'))
  })

  it('never serves files outside the web root', async () => {
    for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const res = await get(url)
      expect(res.body).not.toContain('top secret')
    }
  })
})

describe('SPA fallback', () => {
  it('non-API routes return index.html', async () => {
    for (const url of ['/login', '/shared/abc', '/some/deep/client/route', '/login?next=%2F']) {
      expectIndexHtml(await get(url))
    }
  })

  it('HEAD on a client route is answered like GET', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/login' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
  })

  it('unknown /api/* returns the JSON 404, never the SPA shell', async () => {
    for (const url of ['/api', '/api/', '/api/nope', '/api/notes/x/nope', '/api/nope.html', '/api?x=1']) {
      expectJsonNotFound(await get(url))
    }
  })

  it('a mutating request to a client route is a JSON 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/login', headers: { origin: ORIGIN }, payload: {} })
    expectJsonNotFound(res)
  })

  it('API routes still answer normally', async () => {
    const res = await get('/api/health')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
    // private routes keep their auth guard
    expect((await get('/api/tree')).statusCode).toBe(401)
  })
})

describe('/shared/* page headers', () => {
  it('the shared-note page carries Referrer-Policy: no-referrer and X-Robots-Tag: noindex', async () => {
    for (const url of ['/shared/abc', '/shared/abc?exp=123&sig=xyz', '/shared', '/shared/']) {
      const res = await get(url)
      expectIndexHtml(res)
      expect(res.headers['referrer-policy']).toBe('no-referrer')
      expect(res.headers['x-robots-tag']).toBe('noindex')
    }
  })

  it('other pages do not get the shared-page headers', async () => {
    for (const url of ['/', '/login', '/sharedfoo']) {
      const res = await get(url)
      expect(res.headers['referrer-policy']).toBeUndefined()
      expect(res.headers['x-robots-tag']).toBeUndefined()
    }
  })
})

describe('without a web build', () => {
  it('serves the API only; client routes are JSON 404s', async () => {
    const apiOnly = buildApp({ config, db })
    try {
      expectJsonNotFound(await apiOnly.inject({ method: 'GET', url: '/login' }))
      expectJsonNotFound(await apiOnly.inject({ method: 'GET', url: '/' }))
      expect((await apiOnly.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
    } finally {
      await apiOnly.close()
    }
  })

  it('defaultWebDir points at apps/web/dist', () => {
    expect(defaultWebDir()).toBe(path.resolve(import.meta.dirname, '../../web/dist'))
  })
})
