import { useEffect } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MOBILE_QUERY } from '@/hooks/useMediaQuery'
import { Layout } from './Layout'

/** A `matchMedia` whose mobile query result can be flipped later, notifying listeners like a real resize. */
function stubMatchMedia(mobile: boolean) {
  let matches = mobile
  const listeners = new Set<() => void>()
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return matches && query === MOBILE_QUERY
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    })),
  )
  return {
    setMobile(next: boolean) {
      matches = next
      act(() => listeners.forEach((listener) => listener()))
    },
  }
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

  it('keeps the main pane mounted when the screen crosses the breakpoint', () => {
    const media = stubMatchMedia(false)
    const mounts = vi.fn()
    const unmounts = vi.fn()
    function Pane() {
      useEffect(() => {
        mounts()
        return unmounts
      }, [])
      return <p>Editor pane</p>
    }
    render(
      <Layout sidebar={<nav>Folder tree</nav>}>
        <Pane />
      </Layout>,
    )
    expect(screen.getByRole('separator')).toBeInTheDocument()

    media.setMobile(true)
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    media.setMobile(false)
    expect(screen.getByRole('separator')).toBeInTheDocument()

    expect(within(screen.getByRole('main')).getByText('Editor pane')).toBeInTheDocument()
    expect(mounts).toHaveBeenCalledTimes(1)
    expect(unmounts).not.toHaveBeenCalled()
  })

  it('closes the drawer when the value it closes on changes (a note was opened)', async () => {
    stubMatchMedia(true)
    const ui = (note: string | null) => (
      <Layout sidebar={<nav>Folder tree</nav>} closeDrawerOn={note}>
        <p>Editor pane</p>
      </Layout>
    )
    const { rerender } = render(ui(null))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open sidebar' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()

    rerender(ui(null))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    rerender(ui('note-1'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
