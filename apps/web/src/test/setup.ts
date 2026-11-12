import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { toast } from 'sonner'
import { resetSavers } from '@/features/editor/api'

// jsdom lacks ResizeObserver, which react-resizable-panels needs
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

// jsdom lacks IntersectionObserver (the PDF viewer loads once it is in view); by default everything
// observed is reported as in view at once. Tests of the gating stub their own.
if (!('IntersectionObserver' in globalThis)) {
  globalThis.IntersectionObserver = class {
    private readonly callback: IntersectionObserverCallback
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback
    }
    observe(target: Element) {
      this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  } as unknown as typeof IntersectionObserver
}

// jsdom lacks matchMedia (used by sonner and the layout); default to a wide screen with no preferences
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

// jsdom has no layout; ProseMirror (TipTap) measures ranges when it scrolls the selection into view
if (typeof Range.prototype.getClientRects !== 'function') {
  const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getClientRects = emptyRects
  Range.prototype.getBoundingClientRect = () => new DOMRect()
}
if (typeof document.elementFromPoint !== 'function') {
  document.elementFromPoint = () => null
}

afterEach(() => {
  cleanup()
  // sonner's toast store is global and replays every still-active toast to a newly mounted Toaster,
  // so a toast left by one test would show up again in the next
  toast.dismiss()
  // a save a test held back must not make a later test's note load wait for it
  resetSavers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})
