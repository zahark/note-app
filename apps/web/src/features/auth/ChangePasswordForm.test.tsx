import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockFetch, renderWithProviders } from '@/test/utils'
import { ChangePasswordForm } from './ChangePasswordForm'

async function submit(current: string, next: string, confirm: string) {
  const user = userEvent.setup()
  if (current) await user.type(screen.getByLabelText('Current password'), current)
  if (next) await user.type(screen.getByLabelText('New password'), next)
  if (confirm) await user.type(screen.getByLabelText('Confirm new password'), confirm)
  await user.click(screen.getByRole('button', { name: 'Change password' }))
}

describe('ChangePasswordForm', () => {
  it('validates locally before calling the API', async () => {
    const { requests } = mockFetch({})
    renderWithProviders(<ChangePasswordForm />)
    await submit('', 'short', 'other')
    expect(await screen.findByText('Current password is required')).toBeInTheDocument()
    expect(screen.getByText('Password must be at least 10 characters')).toBeInTheDocument()
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument()
    expect(requests).toHaveLength(0)
  })

  it('shows the server error for a wrong current password', async () => {
    mockFetch({
      'POST /api/auth/change-password': {
        status: 403,
        body: { error: { code: 'WRONG_PASSWORD', message: 'Current password is incorrect' } },
      },
    })
    renderWithProviders(<ChangePasswordForm />)
    await submit('old-password', 'new-password-1', 'new-password-1')
    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect')
  })

  it('submits and confirms success, clearing the fields', async () => {
    const { requests } = mockFetch({ 'POST /api/auth/change-password': { status: 204 } })
    renderWithProviders(<ChangePasswordForm />)
    await submit('old-password', 'new-password-1', 'new-password-1')
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed')
    expect(requests[0]?.body).toEqual({ currentPassword: 'old-password', newPassword: 'new-password-1' })
    expect(screen.getByLabelText('Current password')).toHaveValue('')
    expect(screen.getByLabelText('New password')).toHaveValue('')
  })
})
