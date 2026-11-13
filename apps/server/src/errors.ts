import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'

/** Uniform error body returned by every endpoint: `{error:{code,message}}`. */
export interface ErrorBody {
  error: { code: string; message: string }
}

/** An expected, client-facing error. Anything else thrown by a handler becomes a generic 500. */
export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  /** Extra response headers (e.g. `Retry-After` on a 429). */
  readonly headers: Record<string, string>

  constructor(statusCode: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.headers = headers
  }
}

export const badRequest = (message = 'Bad request', code = 'BAD_REQUEST') =>
  new AppError(400, code, message)
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message)
export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message)
export const conflict = (message = 'Conflict', code = 'CONFLICT') => new AppError(409, code, message)
/** 429; with `retryAfterMs`, also sends `Retry-After` in whole seconds (at least 1). */
export const tooManyRequests = (message = 'Too many requests', retryAfterMs?: number) =>
  new AppError(
    429,
    'RATE_LIMITED',
    message,
    retryAfterMs === undefined
      ? {}
      : { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
  )
export const unsupportedMediaType = (message: string) =>
  new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', message)
export const serviceUnavailable = (message = 'Server busy, try again shortly') =>
  new AppError(503, 'BUSY', message)

/** The message of anything thrown: an `Error`'s message, or the thrown value as a string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } }
}

/** Generic codes for client errors raised by Fastify itself (bad JSON, body too large, ...). */
const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
}

/** Global Fastify error handler: maps every error to `{error:{code,message}}` without leaking internals. */
export function errorHandler(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).headers(err.headers).send(errorBody(err.code, err.message))
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0]
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''
    return reply
      .status(400)
      .send(errorBody('VALIDATION_ERROR', issue ? `${where}${issue.message}` : 'Invalid request'))
  }
  const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500
  if (status >= 400 && status < 500) {
    if ('validation' in err && err.validation) {
      return reply.status(400).send(errorBody('VALIDATION_ERROR', err.message))
    }
    return reply.status(status).send(errorBody(STATUS_CODES[status] ?? 'BAD_REQUEST', err.message))
  }
  request.log.error({ err }, 'unhandled error')
  return reply.status(500).send(errorBody('INTERNAL', 'Internal server error'))
}
