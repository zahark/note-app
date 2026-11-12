import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MOBILE_QUERY } from '@/hooks/useMediaQuery'
import { Layout } from './Layout'

function stubMatchMedia(mobile: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: mobile && query === MOBILE_QUERY,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

const renderLayout = () =>
  render(
    <Layout sidebar={<nav>Folder tree</nav>}>
      <p>Editor pane</p>
    </Layout>,
  )

describe('Layout', () => {
  it('shows the sidebar and main pane side by side with a resize handle on wide screens', () => {
    stubMatchMedia(false)
    renderLayout()
    expect(within(screen.getByRole('complementary', { name: 'Sidebar' })).getByText('Folder tree')).toBeInTheDocument()
    expect(within(screen.getByRole('main')).getByText('Editor pane')).toBeInTheDocument()
    expect(screen.getByRole('separator')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).not.toBeInTheDocument()
  })

  it('hides the sidebar in a drawer on narrow screens', async () => {
    stubMatchMedia(true)
    renderLayout()
    expect(within(screen.getByRole('main')).getByText('Editor pane')).toBeInTheDocument()
    expect(screen.queryByText('Folder tree')).not.toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Open sidebar' }))
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText('Folder tree')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
