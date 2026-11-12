import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api } from '@/lib/api'
import { mockFetch, renderApp, testUser, unauthorizedResponse } from '@/test/utils'

describe('redirect to login on 401', () => {
  it('redirects / to /login without a session', async () => {
    mockFetch({ 'GET /api/auth/me': unauthorizedResponse })
    renderApp('/')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'))
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('redirects unknown paths through / to /login', async () => {
    mockFetch({ 'GET /api/auth/me': unauthorizedResponse })
    renderApp('/no/such/page')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'))
  })

  it('renders the app shell with a session', async () => {
    mockFetch({ 'GET /api/auth/me': { body: { user: testUser } } })
    renderApp('/')
    expect(await screen.findByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/)
  })

  it('redirects to /login when any later request fails with a session 401', async () => {
    mockFetch({
      'GET /api/auth/me': { body: { user: testUser } },
      'GET /api/tree': unauthorizedResponse,
    })
    const { client } = renderApp('/')
    await screen.findByRole('button', { name: 'Settings' })
    await act(async () => {
      await client.fetchQuery({ queryKey: ['tree'], queryFn: () => api.get('/api/tree') }).catch(() => {})
    })
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'))
  })

  it('also redirects when a mutation fails with a session 401', async () => {
    mockFetch({
      'GET /api/auth/me': { body: { user: testUser } },
      'POST /api/folders': unauthorizedResponse,
    })
    const { client } = renderApp('/')
    await screen.findByRole('button', { name: 'Settings' })
    await act(async () => {
      await client
        .getMutationCache()
        .build(client, { mutationFn: () => api.post('/api/folders', { name: 'x' }) })
        .execute(undefined)
        .catch(() => {})
    })
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'))
  })

  it('does not treat a non-session error as a logout', async () => {
    mockFetch({
      'GET /api/auth/me': { body: { user: testUser } },
      'GET /api/tree': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found' } } },
    })
    const { client } = renderApp('/')
    await screen.findByRole('button', { name: 'Settings' })
    await act(async () => {
      await client.fetchQuery({ queryKey: ['tree'], queryFn: () => api.get('/api/tree') }).catch(() => {})
    })
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/)
  })

  it('returns to the original page after signing in', async () => {
    let signedIn = false
    mockFetch({
      'GET /api/auth/me': () => (signedIn ? { body: { user: testUser } } : unauthorizedResponse),
      'POST /api/auth/login': () => {
        signedIn = true
        return { body: { user: testUser } }
      },
    })
    renderApp('/?note=abc')
    await screen.findByRole('heading', { name: 'Sign in' })
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })

  it('serves /shared/:id without a session and without redirecting', async () => {
    const { requests } = mockFetch({ 'GET /api/auth/me': unauthorizedResponse })
    renderApp('/shared/abc')
    expect(await screen.findByText('Loading shared note…')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/shared/abc')
    expect(requests.some((r) => r.path === '/api/auth/me')).toBe(false)
  })

  it('signs out from Settings and returns to /login', async () => {
    const { requests } = mockFetch({
      'GET /api/auth/me': { body: { user: testUser } },
      'POST /api/auth/logout': { status: 204 },
    })
    renderApp('/')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Settings' }))
    await user.click(await screen.findByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/login'))
    expect(requests.some((r) => r.method === 'POST' && r.path === '/api/auth/logout')).toBe(true)
  })
})
