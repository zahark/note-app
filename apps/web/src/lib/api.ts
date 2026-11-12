/**
 * Typed fetch client for the same-origin API. Every server error has the shape
 * `{error:{code,message}}`; it is surfaced as an `ApiError` carrying the status, code and message.
 */

export interface ApiErrorBody {
  error: { code: string; message: string }
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** Seconds from a `Retry-After` header (429), if present. */
  readonly retryAfter: number | undefined

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

/** The session is missing or expired (as opposed to e.g. wrong login credentials, which is also a 401). */
export const isUnauthorized = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 401 && err.code === 'UNAUTHORIZED'

/** The server could not be reached or failed (network error or 5xx), as opposed to refusing the request. */
export const isUnreachable = (err: unknown): boolean =>
  err instanceof ApiError && (err.status === 0 || err.status >= 500)

/** The requested resource does not exist (404). */
export const isNotFound = (err: unknown): boolean => err instanceof ApiError && err.status === 404

/** User-facing text for a failed request (an `ApiError` carries the server's message). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return 'Something went wrong, try again'
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RequestOptions {
  method?: HttpMethod
  /** JSON-serialized unless it is a `FormData` or `Blob`, which are sent as-is. */
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Defaults to `same-origin`; the public shared view uses `omit` (it never needs the session cookie). */
  credentials?: 'same-origin' | 'omit'
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const err = (value as { error: unknown }).error
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { message?: unknown }).message === 'string'
  )
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

async function toApiError(res: Response): Promise<ApiError> {
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  if (isErrorBody(body)) return new ApiError(res.status, body.error.code, body.error.message, retryAfter)
  return new ApiError(res.status, 'HTTP_ERROR', `Request failed (${res.status})`, retryAfter)
}

/** Performs a request and returns the parsed JSON body (`undefined` for an empty or 204 response). */
export async function apiFetch<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers }
  let body: BodyInit | undefined
  if (opts.body instanceof FormData || opts.body instanceof Blob) {
    body = opts.body
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  let res: Response
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      // same-origin only: the session cookie is never sent anywhere else
      credentials: opts.credentials ?? 'same-origin',
      headers,
      body,
      signal: opts.signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError(0, 'NETWORK_ERROR', 'Network error, check your connection')
  }

  if (!res.ok) throw await toApiError(res)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiFetch<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
}
