import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { conflict, notFound } from '../src/errors.js'

const config = loadConfig({
  SESSION_SECRET: 'a'.repeat(32),
  SHARE_HMAC_KEY: 'b'.repeat(32),
  PUBLIC_ORIGIN: 'http://localhost:3000',
})

let app: FastifyInstance

beforeEach(() => {
  app = buildApp({ config })
  app.get('/test/not-found', async () => {
    throw notFound()
  })
  app.get('/test/conflict', async () => {
    throw conflict('Stale version', 'VERSION_CONFLICT')
  })
  app.get('/test/crash', async () => {
    throw new Error('secret internal detail')
  })
  app.post('/test/zod', async (request) => z.object({ name: z.string() }).parse(request.body))
})

afterEach(async () => {
  await app.close()
})

describe('GET /api/health', () => {
  it('returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('exposes the injected config', () => {
    expect(app.config).toBe(config)
  })
})

describe('error format {error:{code,message}}', () => {
  it('unknown route → 404 NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } })
  })

  it('AppError keeps its status, code and message', async () => {
    const notFoundRes = await app.inject({ method: 'GET', url: '/test/not-found' })
    expect(notFoundRes.statusCode).toBe(404)
    expect(notFoundRes.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } })

    const conflictRes = await app.inject({ method: 'GET', url: '/test/conflict' })
    expect(conflictRes.statusCode).toBe(409)
    expect(conflictRes.json()).toEqual({
      error: { code: 'VERSION_CONFLICT', message: 'Stale version' },
    })
  })

  it('unexpected errors → 500 with a generic message (no internals leaked)', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/crash' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } })
    expect(res.body).not.toContain('secret internal detail')
  })

  it('zod validation failures → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({ method: 'POST', url: '/test/zod', payload: { name: 5 } })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toContain('name')
  })

  it('malformed JSON body → 400 BAD_REQUEST in the uniform shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/zod',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('BAD_REQUEST')
    expect(typeof body.error.message).toBe('string')
  })

  it('unsupported content type → 415 in the uniform shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test/zod',
      headers: { 'content-type': 'application/x-unknown' },
      payload: 'x',
    })
    expect(res.statusCode).toBe(415)
    expect((res.json() as { error: { code: string } }).error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })
})
