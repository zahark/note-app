import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockFetch, renderApp, testUser, unauthorizedResponse } from '@/test/utils'

const signedOut = { 'GET /api/auth/me': unauthorizedResponse }

async function fillLogin(email: string, password: string) {
  const user = userEvent.setup()
  if (email) await user.type(screen.getByLabelText('Email'), email)
  if (password) await user.type(screen.getByLabelText('Password'), password)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  return user
}

describe('LoginPage — sign in', () => {
  it('shows field errors and does not call the API when fields are empty', async () => {
    const { requests } = mockFetch(signedOut)
    renderApp('/login')
    await fillLogin('', '')
    expect(await screen.findByText('Email is required')).toBeInTheDocument()
    expect(screen.getByText('Password is required')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
    expect(requests.filter((r) => r.path === '/api/auth/login')).toHaveLength(0)
  })

  it('rejects a malformed email', async () => {
    const { requests } = mockFetch(signedOut)
    renderApp('/login')
    await fillLogin('not-an-email', 'whatever')
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument()
    expect(requests.filter((r) => r.path === '/api/auth/login')).toHaveLength(0)
  })

  it('shows the server error on wrong credentials and stays on /login', async () => {
    mockFetch({
      ...signedOut,
      'POST /api/auth/login': {
        status: 401,
        body: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } },
      },
    })
    renderApp('/login')
    await fillLogin('owner@example.com', 'wrong-password')
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password')
    expect(screen.getByTestId('location')).toHaveTextContent('/login')
  })

  it('shows the rate-limit message on 429', async () => {
    mockFetch({
      ...signedOut,
      'POST /api/auth/login': {
        status: 429,
        headers: { 'retry-after': '30' },
        body: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, try again later' } },
      },
    })
    renderApp('/login')
    await fillLogin('owner@example.com', 'some-password')
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts, try again later')
  })

  it('signs in with trimmed email and navigates home', async () => {
    const { requests } = mockFetch({
      ...signedOut,
      'POST /api/auth/login': { body: { user: testUser } },
    })
    renderApp('/login')
    await fillLogin('  owner@example.com ', 'correct-password')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/))
    const login = requests.find((r) => r.path === '/api/auth/login')
    expect(login?.body).toEqual({ email: 'owner@example.com', password: 'correct-password' })
    expect(await screen.findByRole('button', { name: 'Settings' })).toBeInTheDocument()
  })

  it('redirects an already signed-in user away from /login', async () => {
    mockFetch({ 'GET /api/auth/me': { body: { user: testUser } } })
    renderApp('/login')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/))
  })
})

describe('LoginPage — sign up', () => {
  async function openSignup() {
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Create one' }))
    expect(screen.getByRole('heading', { name: 'Create account' })).toBeInTheDocument()
    return user
  }

  it('enforces the password policy and confirmation before calling the API', async () => {
    const { requests } = mockFetch(signedOut)
    renderApp('/login')
    const user = await openSignup()
    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'short')
    await user.type(screen.getByLabelText('Confirm password'), 'different')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Password must be at least 10 characters')).toBeInTheDocument()
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument()
    expect(requests.filter((r) => r.path === '/api/auth/signup')).toHaveLength(0)
  })

  it('rejects passwords over 256 characters', async () => {
    mockFetch(signedOut)
    renderApp('/login')
    const user = await openSignup()
    const long = 'a'.repeat(257)
    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.click(screen.getByLabelText('Password'))
    await user.paste(long)
    await user.click(screen.getByLabelText('Confirm password'))
    await user.paste(long)
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Password must be at most 256 characters')).toBeInTheDocument()
  })

  it('shows the server error when signup is disabled', async () => {
    mockFetch({
      ...signedOut,
      'POST /api/auth/signup': {
        status: 403,
        body: { error: { code: 'SIGNUP_DISABLED', message: 'Signup is disabled' } },
      },
    })
    renderApp('/login')
    const user = await openSignup()
    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'long-enough-pw')
    await user.type(screen.getByLabelText('Confirm password'), 'long-enough-pw')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Signup is disabled')
  })

  it('creates the account and navigates home', async () => {
    const { requests } = mockFetch({
      ...signedOut,
      'POST /api/auth/signup': { status: 201, body: { user: testUser } },
    })
    renderApp('/login')
    const user = await openSignup()
    await user.type(screen.getByLabelText('Email'), 'owner@example.com')
    await user.type(screen.getByLabelText('Password'), 'long-enough-pw')
    await user.type(screen.getByLabelText('Confirm password'), 'long-enough-pw')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/))
    expect(requests.find((r) => r.path === '/api/auth/signup')?.body).toEqual({
      email: 'owner@example.com',
      password: 'long-enough-pw',
    })
  })
})
