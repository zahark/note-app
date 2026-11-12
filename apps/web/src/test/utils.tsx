import { render } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { vi } from 'vitest'
import { AppProviders, AppRoutes } from '@/App'
import { createQueryClient } from '@/lib/queryClient'

export interface MockResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

export interface RecordedRequest {
  method: string
  path: string
  body: unknown
  init: RequestInit
}

type Handler = (req: RecordedRequest) => MockResponse | undefined | Promise<MockResponse | undefined>

/**
 * Replaces `fetch` with a router over `"METHOD /path"` keys. Unmatched requests get a 404 error body.
 * A handler may return a promise, to hold a response back until the test releases it.
 * Returns the list of requests made, for assertions.
 */
export function mockFetch(routes: Record<string, MockResponse | Handler>) {
  const requests: RecordedRequest[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    const req = { method, path, body, init }
    requests.push(req)
    const route = routes[`${method} ${path}`]
    const res = (typeof route === 'function' ? await route(req) : route) ?? {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Not found' } },
    }
    const status = res.status ?? 200
    const payload = status === 204 || res.body === undefined ? null : JSON.stringify(res.body)
    return new Response(payload, {
      status,
      headers: { 'content-type': 'application/json', ...res.headers },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { requests, fetchMock }
}

export const unauthorizedResponse: MockResponse = {
  status: 401,
  body: { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
}

export const testUser = { id: 'u1', email: 'owner@example.com', isOwner: true }

/** Shows the current router location (path and query string) so tests can assert on navigation. */
function LocationProbe() {
  const location = useLocation()
  return (
    <>
      <div data-testid="location">{location.pathname}</div>
      <div data-testid="search">{location.search}</div>
    </>
  )
}

/** Renders the full route table at `path` with a fresh query client. */
export function renderApp(path: string, client: QueryClient = createQueryClient()) {
  const result = render(
    <AppProviders client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
        <LocationProbe />
      </MemoryRouter>
    </AppProviders>,
  )
  return { ...result, client }
}

/** Renders a single element inside providers and a router (with a probe for the location). */
export function renderWithProviders(ui: ReactElement, path = '/', client: QueryClient = createQueryClient()) {
  const result = render(
    <AppProviders client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </AppProviders>,
  )
  return { ...result, client }
}
