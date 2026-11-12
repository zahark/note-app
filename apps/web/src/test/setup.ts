import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { resetSavers } from '@/features/editor/api'

// jsdom lacks ResizeObserver, which react-resizable-panels needs
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
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
  // a save a test held back must not make a later test's note load wait for it
  resetSavers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})
