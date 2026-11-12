import { mockFetch } from '@/test/utils'
import { api, apiFetch, apiFetchResponse, ApiError, isNotFound, isUnauthorized, isUnreachable } from './api'

describe('apiFetch', () => {
  it('sends same-origin credentials and parses the JSON body', async () => {
    const { requests } = mockFetch({ 'GET /api/tree': { body: { folders: [], notes: [] } } })
    await expect(api.get('/api/tree')).resolves.toEqual({ folders: [], notes: [] })
    expect(requests[0]?.init.credentials).toBe('same-origin')
    expect(requests[0]?.method).toBe('GET')
  })

  it('asks for JSON; apiFetchResponse (a file body) sends no accept header unless the caller passes one', async () => {
    const { requests } = mockFetch({ 'GET /api/tree': { body: {} }, 'GET /api/attachments/a1': { body: 'bytes' } })
    await api.get('/api/tree')
    await apiFetchResponse('/api/attachments/a1')
    await apiFetchResponse('/api/attachments/a1', { headers: { accept: 'application/pdf' } })
    const accepts = requests.map((r) => (r.init.headers as Record<string, string>).accept)
    expect(accepts).toEqual(['application/json', undefined, 'application/pdf'])
  })

  it('serializes a JSON body with a content type', async () => {
    const { requests } = mockFetch({ 'POST /api/folders': { status: 201, body: { id: 'f1' } } })
    await expect(api.post('/api/folders', { name: 'Work' })).resolves.toEqual({ id: 'f1' })
    expect(requests[0]?.body).toEqual({ name: 'Work' })
    expect((requests[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/json')
  })

  it('sends FormData as-is without a JSON content type', async () => {
    const { requests } = mockFetch({ 'POST /api/attachments': { status: 201, body: { id: 'a1' } } })
    const form = new FormData()
    form.append('file', new Blob(['x']), 'x.png')
    await apiFetch('/api/attachments', { method: 'POST', body: form })
    expect(requests[0]?.init.body).toBe(form)
    expect((requests[0]?.init.headers as Record<string, string>)['content-type']).toBeUndefined()
  })

  it('returns undefined for 204 No Content', async () => {
    mockFetch({ 'POST /api/auth/logout': { status: 204 } })
    await expect(api.post('/api/auth/logout')).resolves.toBeUndefined()
  })

  it('throws ApiError with the server code and message', async () => {
    mockFetch({
      'POST /api/auth/login': {
        status: 401,
        body: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } },
      },
    })
    const err = await api.post('/api/auth/login', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' })
    expect(isUnauthorized(err)).toBe(false)
  })

  it('reads Retry-After on 429', async () => {
    mockFetch({
      'POST /api/auth/login': {
        status: 429,
        headers: { 'retry-after': '42' },
        body: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } },
      },
    })
    await expect(api.post('/api/auth/login', {})).rejects.toMatchObject({ status: 429, retryAfter: 42 })
  })

  it('falls back to a generic error for a non-JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })))
    await expect(api.get('/api/tree')).rejects.toMatchObject({ status: 502, code: 'HTTP_ERROR' })
  })

  it('turns a network failure into a NETWORK_ERROR ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(api.get('/api/tree')).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' })
  })

  it('identifies a session 401', () => {
    expect(isUnauthorized(new ApiError(401, 'UNAUTHORIZED', 'Authentication required'))).toBe(true)
    expect(isUnauthorized(new ApiError(404, 'NOT_FOUND', 'Not found'))).toBe(false)
    expect(isUnauthorized(new Error('x'))).toBe(false)
  })

  it('identifies an unreachable server (network error or 5xx) and a missing resource', () => {
    expect(isUnreachable(new ApiError(0, 'NETWORK_ERROR', 'Network error'))).toBe(true)
    expect(isUnreachable(new ApiError(503, 'BUSY', 'Server busy'))).toBe(true)
    expect(isUnreachable(new ApiError(429, 'RATE_LIMITED', 'Too many'))).toBe(false)
    expect(isUnreachable(new ApiError(404, 'NOT_FOUND', 'Not found'))).toBe(false)
    expect(isUnreachable(new Error('x'))).toBe(false)
    expect(isNotFound(new ApiError(404, 'NOT_FOUND', 'Not found'))).toBe(true)
    expect(isNotFound(new ApiError(400, 'BAD_REQUEST', 'Bad request'))).toBe(false)
    expect(isNotFound(new Error('x'))).toBe(false)
  })
})
