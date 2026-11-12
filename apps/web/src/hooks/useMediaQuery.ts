import { useSyncExternalStore } from 'react'

/** Live result of a CSS media query (false where `matchMedia` is unavailable). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => {}
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  )
}

/** Below Tailwind's `md` breakpoint the sidebar becomes a drawer. */
export const MOBILE_QUERY = '(max-width: 767px)'

export const useIsMobile = () => useMediaQuery(MOBILE_QUERY)
