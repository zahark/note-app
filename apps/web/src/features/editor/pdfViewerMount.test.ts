import { createElement, useEffect } from 'react'
import { act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { mountPdfViewer } from './pdfViewerMount'

const viewer = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }))

// a stand-in viewer that records its mount and unmount (the real one has its own tests)
vi.mock('./PdfViewer', () => ({
  PdfViewer: ({ aid }: { aid: string }) => {
    useEffect(() => {
      viewer.mounted(aid)
      return () => viewer.unmounted(aid)
    }, [aid])
    return createElement('p', { 'data-testid': 'viewer' }, aid)
  },
}))

const AID = '0b4c2f7e-1d2a-4c3b-9e8f-0123456789ab'
const resolver = (aid: string) => `/api/attachments/${aid}`

describe('mountPdfViewer', () => {
  it('renders the viewer for the aid into its own host element in the slot', async () => {
    const slot = document.createElement('div')
    let mount!: ReturnType<typeof mountPdfViewer>
    await act(async () => {
      mount = mountPdfViewer(slot, AID, resolver)
    })
    expect(slot.children).toHaveLength(1)
    expect(slot.querySelector('[data-testid="viewer"]')!.textContent).toBe(AID)
    expect(viewer.mounted).toHaveBeenCalledWith(AID)
    await act(async () => mount.destroy())
  })

  it('destroy unmounts the viewer after a microtask and removes the host; a second destroy does nothing', async () => {
    viewer.unmounted.mockClear()
    const slot = document.createElement('div')
    let mount!: ReturnType<typeof mountPdfViewer>
    await act(async () => {
      mount = mountPdfViewer(slot, AID, resolver)
    })

    mount.destroy()
    mount.destroy()
    // deferred: the node view may be destroyed while React is rendering
    expect(slot.children).toHaveLength(1)
    await act(async () => {})
    expect(slot.children).toHaveLength(0)
    expect(viewer.unmounted).toHaveBeenCalledTimes(1)
  })

  it('a later mount into the same slot gets a fresh host, even while the previous one is still unmounting', async () => {
    const slot = document.createElement('div')
    let first!: ReturnType<typeof mountPdfViewer>
    let second!: ReturnType<typeof mountPdfViewer>
    await act(async () => {
      first = mountPdfViewer(slot, AID, resolver)
      first.destroy()
      second = mountPdfViewer(slot, AID, resolver)
    })
    expect(slot.children).toHaveLength(1)
    expect(slot.querySelector('[data-testid="viewer"]')).not.toBeNull()
    await act(async () => second.destroy())
    expect(slot.children).toHaveLength(0)
  })
})
