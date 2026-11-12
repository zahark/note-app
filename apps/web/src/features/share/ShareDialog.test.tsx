import { createElement } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { TreeNote } from '@/features/tree/buildTree'
import { mockFetch, renderWithProviders, type MockResponse } from '@/test/utils'
import { shareStatusText } from './api'
import { ShareButton } from './ShareDialog'

const NOTE_ID = '44444444-4444-4444-8444-444444444444'
const SHARE_PATH = `/api/notes/${NOTE_ID}/share`
const SIGNED_URL = `http://localhost:3000/shared/${NOTE_ID}?exp=1999999999&sig=abc`

const note = (overrides: Partial<TreeNote> = {}): TreeNote => ({
  id: NOTE_ID,
  folder_id: null,
  title: 'Trip plan',
  version: 3,
  created_at: 1,
  updated_at: 1,
  share_type: 'private',
  expires_at: null,
  ...overrides,
})
const tree = (n: TreeNote): MockResponse => ({ body: { folders: [], notes: [n] } })

async function openDialog(initial: TreeNote = note(), routes: Record<string, MockResponse> = {}) {
  const user = userEvent.setup()
  const mock = mockFetch({ 'GET /api/tree': tree(initial), ...routes })
  renderWithProviders(createElement(ShareButton, { note: initial }))
  await user.click(await screen.findByRole('button', { name: initial.share_type === 'private' ? 'Share' : 'Shared' }))
  const dialog = await screen.findByRole('dialog')
  return { user, dialog, ...mock }
}

describe('ShareDialog', () => {
  it('creates a PIN share and shows the link and PIN once, with copy buttons', async () => {
    const { user, dialog, requests } = await openDialog(note(), {
      [`POST ${SHARE_PATH}`]: { body: { share: { type: 'password_protected', pin: 'ABCD2345' } } },
    })
    expect(within(dialog).getByTestId('share-status')).toHaveTextContent('Not shared.')
    await user.click(within(dialog).getByRole('button', { name: 'Create PIN' }))

    expect(await within(dialog).findByLabelText('Shared pin')).toHaveValue('ABCD2345')
    expect(within(dialog).getByLabelText('Shared link')).toHaveValue(`${window.location.origin}/shared/${NOTE_ID}`)
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ type: 'password_protected' })
    expect(within(dialog).getByTestId('share-status')).toHaveTextContent('Shared with a PIN.')
    expect(within(dialog).getByRole('button', { name: 'New PIN' })).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Copy pin' }))
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('ABCD2345'))

    // closing the dialog forgets the PIN: it is never shown again (the note's button now reads "Shared")
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Shared' }))
    const reopened = await screen.findByRole('dialog')
    expect(within(reopened).queryByLabelText('Shared pin')).not.toBeInTheDocument()
    expect(within(reopened).getByTestId('share-status')).toHaveTextContent('Shared with a PIN.')
  })

  it('creates an expiring link with the chosen expiry and shows the returned URL', async () => {
    const { user, dialog, requests } = await openDialog(note(), {
      [`POST ${SHARE_PATH}`]: {
        body: { share: { type: 'signed_url', exp: 1999999999, sig: 'abc', url: SIGNED_URL } },
      },
    })
    await user.selectOptions(within(dialog).getByLabelText('Link expiry'), '1 day')
    await user.click(within(dialog).getByRole('button', { name: 'Create link' }))

    expect(await within(dialog).findByLabelText('Shared link')).toHaveValue(SIGNED_URL)
    expect(within(dialog).queryByLabelText('Shared pin')).not.toBeInTheDocument()
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ type: 'signed_url', expires_in: '1d' })
    expect(within(dialog).getByTestId('share-status')).toHaveTextContent(/^Shared by a link until /)
    expect(within(dialog).getByRole('button', { name: 'New link' })).toBeInTheDocument()
  })

  it('stops sharing', async () => {
    const shared = note({ share_type: 'signed_url', expires_at: 1999999999 })
    const { user, dialog, requests } = await openDialog(shared, { [`DELETE ${SHARE_PATH}`]: { status: 204 } })
    await user.click(within(dialog).getByRole('button', { name: 'Stop sharing' }))

    await waitFor(() => expect(within(dialog).getByTestId('share-status')).toHaveTextContent('Not shared.'))
    expect(requests.some((r) => r.method === 'DELETE' && r.path === SHARE_PATH)).toBe(true)
    expect(within(dialog).queryByRole('button', { name: 'Stop sharing' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(await screen.findByRole('button', { name: 'Share' })).toBeInTheDocument()
  })

  it('shows an error toast and no link when sharing fails', async () => {
    const { user, dialog } = await openDialog(note(), {
      [`POST ${SHARE_PATH}`]: { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Note not found' } } },
    })
    await user.click(within(dialog).getByRole('button', { name: 'Create PIN' }))
    expect(await screen.findByText('Could not share the note: Note not found')).toBeInTheDocument()
    expect(within(dialog).queryByTestId('created-share')).not.toBeInTheDocument()
    expect(within(dialog).getByTestId('share-status')).toHaveTextContent('Not shared.')
  })
})

describe('shareStatusText', () => {
  it('describes each share state', () => {
    expect(shareStatusText(note())).toBe('Not shared.')
    expect(shareStatusText(note({ share_type: 'password_protected' }))).toBe('Shared with a PIN.')
    expect(shareStatusText(note({ share_type: 'signed_url', expires_at: 2000 }), 1000)).toMatch(/^Shared by a link until /)
    expect(shareStatusText(note({ share_type: 'signed_url', expires_at: 500 }), 1000)).toMatch(/^The link expired on /)
  })
})
